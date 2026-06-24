// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "./ERCPool.sol";
import "./TradeAccount.sol";
import "./hypercore/IHyperCore.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title HyperTrader (v1 — sub-account buys)
 * @notice Privacy-preserving spot buys on HyperEVM/HyperCore, in two steps:
 *
 *   1. trade(): spend a shielded USDC note (ZK withdrawal, recipient = this
 *      controller — unlinkable to the depositor), then clone an isolated
 *      {TradeAccount} for this trade, fund it, bridge its USDC to HyperCore and
 *      place an IOC spot buy *on that account*.
 *
 *      ⏳ HyperCore fills the order asynchronously, crediting the bought asset to
 *      the trade's own account.
 *
 *   2. deliver(): once the fill is observable, read the trade account's spot
 *      balance (synchronous precompile) to confirm the asset arrived, then push
 *      exactly `size` to the user's chosen address — on HyperEVM (ERC-20) or on
 *      HyperCore (spot account), per the trade's `venue`.
 *
 *   PER-TRADE ISOLATION: because each trade buys on its own {TradeAccount}, the
 *   delivery balance check is unambiguous — an unfilled trade's account is empty,
 *   so it can never deliver against another trade's fill. No shared-account theft.
 *
 *   PRIVACY: shielded USDC in, asset out to a fresh address. The depositor is
 *   hidden by the pool; the trade itself (usdcIn <-> size <-> recipient) is public,
 *   intrinsic to using a transparent venue. Use a fresh `recipient` + a relayer.
 *
 *   RELAYER MODEL: trade() and deliver() are permissionless and the withdrawal
 *   carries `fee`/`feeRecipient`, so a relayer submits both txs (paying gas in
 *   HYPE, reimbursed in USDC) and the user never sends a linked transaction.
 */
contract HyperTrader is ReentrancyGuard {
  using SafeERC20 for IERC20;
  using Clones for address;

  address public admin;
  address public pendingAdmin;

  IHyperCore public core;
  ERCPool public immutable usdcPool; // quote pool: the user spends shielded USDC
  IERC20 public immutable usdc;
  address public immutable tradeAccountImpl; // EIP-1167 implementation for clones

  uint64 public usdcCoreToken; // HyperCore spot token id for USDC

  enum Venue {
    Evm, // deliver as ERC-20 on HyperEVM
    Core // deliver to a HyperCore spot account
  }

  enum Status {
    None,
    Open,
    Delivered
  }

  struct Trade {
    address account; // the cloned TradeAccount holding this trade's funds
    address recipient; // where the bought asset is delivered
    uint64 assetCoreToken; // core token id of the bought asset
    uint64 size; // base size bought (sz units)
    Venue venue;
    Status status;
  }

  struct TradeParams {
    uint32 asset; // HyperCore spot asset id
    uint64 assetCoreToken; // core token id of the bought asset
    uint64 size; // base size to buy (sz units)
    uint64 limitPx; // slippage cap (core px units)
    uint128 cloid; // client order id
    address recipient; // destination address for the bought asset
    Venue venue; // EVM (ERC-20) or CORE (spot account)
  }

  mapping(uint256 => Trade) public trades;
  uint256 public nextTradeId;

  event CoreConfigured(address indexed core, uint64 usdcCoreToken);
  event AdminChanged(address indexed oldAdmin, address indexed newAdmin);
  event Traded(
    uint256 indexed tradeId,
    address account,
    address recipient,
    uint32 asset,
    uint64 assetCoreToken,
    uint64 size,
    uint64 limitPx,
    uint128 cloid,
    uint256 usdcIn,
    uint8 venue
  );
  event Delivered(uint256 indexed tradeId, address recipient, uint64 assetCoreToken, uint64 size, uint8 venue);

  modifier onlyAdmin() {
    require(msg.sender == admin, "only admin");
    _;
  }

  constructor(address _admin, ERCPool _usdcPool, address _tradeAccountImpl) {
    require(_admin != address(0), "admin is zero address");
    require(address(_usdcPool) != address(0), "pool is zero address");
    require(_tradeAccountImpl != address(0), "impl is zero address");
    admin = _admin;
    usdcPool = _usdcPool;
    usdc = _usdcPool.token();
    tradeAccountImpl = _tradeAccountImpl;
  }

  // ----------------------------------------------------------------- config

  function configureCore(IHyperCore _core, uint64 _usdcCoreToken) external onlyAdmin {
    require(address(_core) != address(0), "zero address");
    core = _core;
    usdcCoreToken = _usdcCoreToken;
    emit CoreConfigured(address(_core), _usdcCoreToken);
  }

  function transferAdmin(address _newAdmin) external onlyAdmin {
    require(_newAdmin != address(0), "new admin is zero address");
    pendingAdmin = _newAdmin;
  }

  function claimAdmin() external {
    require(msg.sender == pendingAdmin, "not pending admin");
    emit AdminChanged(admin, pendingAdmin);
    admin = pendingAdmin;
    pendingAdmin = address(0);
  }

  // --------------------------------------------------------------- trading

  /**
   * @notice Step 1: spend a shielded USDC note and open a spot buy on a fresh,
   *         isolated {TradeAccount}.
   * @param proof ZK proof for the USDC pool withdrawal (recipient must be this).
   * @param extData External data; `recipient` must equal this controller and
   *        `extAmount` must be negative. `fee`/`feeRecipient` pay the relayer.
   * @param p Trade parameters (asset, size, slippage cap, destination, venue).
   */
  function trade(
    ERCPool.Proof calldata proof,
    ERCPool.ExtData calldata extData,
    TradeParams calldata p
  ) external nonReentrant returns (uint256 tradeId) {
    require(address(core) != address(0), "core unset");
    require(extData.recipient == address(this), "recipient must be controller");
    require(extData.extAmount < 0, "must be a withdrawal");
    require(p.limitPx > 0, "limitPx is zero");
    require(p.size > 0, "size is zero");
    require(p.recipient != address(0), "recipient is zero");

    uint256 usdcIn = uint256(-extData.extAmount);

    // Verify + execute the shielded withdrawal; the pool sends `usdcIn` USDC here.
    uint256 balBefore = usdc.balanceOf(address(this));
    usdcPool.transact(proof, extData);
    require(usdc.balanceOf(address(this)) - balBefore == usdcIn, "unexpected usdc in");

    tradeId = nextTradeId++;

    // One isolated HyperCore account per trade (deterministic clone).
    address acct = tradeAccountImpl.cloneDeterministic(bytes32(tradeId));
    TradeAccount(acct).initialize(address(this), core);

    // Fund it and place the buy *on its own account*.
    usdc.safeTransfer(acct, usdcIn);
    TradeAccount(acct).fundAndBuy(
      usdc,
      usdcCoreToken,
      usdcIn,
      IHyperCore.SpotBuyParams({asset: p.asset, size: p.size, limitPx: p.limitPx, tif: IHyperCore.Tif.Ioc, cloid: p.cloid})
    );

    trades[tradeId] = Trade({
      account: acct,
      recipient: p.recipient,
      assetCoreToken: p.assetCoreToken,
      size: p.size,
      venue: p.venue,
      status: Status.Open
    });

    emit Traded(tradeId, acct, p.recipient, p.asset, p.assetCoreToken, p.size, p.limitPx, p.cloid, usdcIn, uint8(p.venue));
  }

  /**
   * @notice Step 2: once this trade's order has filled, push the bought asset to
   *         the user. Permissionless (keeper/relayer-friendly).
   * @dev The balance is read on the trade's OWN account, so the asset can only be
   *      this trade's fill — no cross-trade theft.
   */
  function deliver(uint256 tradeId) external nonReentrant {
    Trade storage t = trades[tradeId];
    require(t.status == Status.Open, "not open");
    require(core.spotBalance(t.account, t.assetCoreToken) >= t.size, "not filled");

    t.status = Status.Delivered;
    TradeAccount(t.account).deliver(t.recipient, t.assetCoreToken, t.size, t.venue == Venue.Evm);

    emit Delivered(tradeId, t.recipient, t.assetCoreToken, t.size, uint8(t.venue));
  }

  /// @notice Deterministic address of a trade's account (set even before trade()).
  function tradeAccountOf(uint256 tradeId) external view returns (address) {
    return tradeAccountImpl.predictDeterministicAddress(bytes32(tradeId), address(this));
  }
}
