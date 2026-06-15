// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "./HyperPrivacyPool.sol";
import "./hypercore/IHyperCore.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title HyperTrader
 * @notice Privacy-preserving spot-trading controller for HyperEVM/HyperCore.
 *
 *         Lifecycle of one anonymous trade (USDC -> spot BTC -> private BTC note):
 *
 *           1. initiateTrade: the user (or a relayer on their behalf) submits a
 *              ZK withdrawal proof against the USDC pool with recipient = this
 *              controller. The pool verifies the proof (commitment in tree,
 *              nullifier unspent, etc.) and releases a fixed amount of USDC to
 *              the controller. The link to the original depositor is broken by
 *              the proof, exactly like a normal shielded withdrawal.
 *
 *           2. The controller bridges the USDC to HyperCore and places a spot
 *              buy for a FIXED base size of BTC (`btcNoteDenom`) with an IOC
 *              limit order. `limitPx` is the slippage cap; the fixed size is the
 *              minimum-BTC-received guarantee. An optional deadline bounds the
 *              order; unfilled orders can be cancelled (refund) or retried.
 *
 *           3. settleTrade: once the BTC fill is observed on HyperCore, the
 *              controller bridges exactly `btcNoteDenom` BTC back into the BTC
 *              pool and mints the user's pre-committed BTC note. The user can
 *              later withdraw/claim that BTC privately via the BTC pool, with no
 *              on-chain link to the USDC deposit that funded it.
 *
 *         Fixed input AND output sizes are what make the trade unlinkable: every
 *         trade looks identical on-chain. Any HyperCore residual (price improvement
 *         or leftover USDC) accrues to the protocol `coreAccount` and is swept by
 *         the admin; it is intentionally excluded from the private notes to keep
 *         every settlement deterministic.
 */
contract HyperTrader is ReentrancyGuard {
  using SafeERC20 for IERC20;

  address public admin;
  address public pendingAdmin;

  IHyperCore public adapter;
  HyperPrivacyPool public immutable usdcPool;
  HyperPrivacyPool public immutable btcPool;
  IERC20 public immutable usdc;
  IERC20 public immutable btc;

  // HyperCore linkage / market config (admin-configurable).
  uint64 public usdcCoreToken;
  uint64 public btcCoreToken;
  uint32 public btcSpotAsset;
  uint64 public btcNoteDenom; // fixed BTC note size, in HyperCore core units
  uint64 public defaultDeadlineSecs;
  address public coreAccount; // HyperCore account holding protocol funds

  enum Status {
    None,
    Open,
    Settled,
    Cancelled
  }

  struct Trade {
    address initiator;
    uint256 usdcIn;
    uint64 size;
    uint64 limitPx;
    uint128 cloid;
    uint64 deadline;
    bytes32 btcCommitment;
    bytes32 btcCommitment2;
    bytes32 refundCommitment;
    Status status;
    bytes encryptedOutput1; // forwarded to NewCommitment for wallet recovery
    bytes encryptedOutput2;
  }

  struct InitiateParams {
    uint64 limitPx; // slippage cap (core px units)
    uint64 deadline; // unix seconds; 0 => now + defaultDeadlineSecs
    uint128 cloid; // client order id
    bytes32 btcCommitment; // resulting BTC note (computed off-chain by user)
    bytes32 btcCommitment2; // paired empty/change note
    bytes32 refundCommitment; // USDC note minted if the trade is cancelled
    bytes encryptedOutput1; // encrypted note payload for indexer/recovery
    bytes encryptedOutput2;
  }

  mapping(uint256 => Trade) public trades;
  uint256 public nextTradeId;

  event TradeInitiated(uint256 indexed tradeId, uint256 usdcIn, uint64 size, uint64 limitPx, uint128 cloid);
  event TradeSettled(uint256 indexed tradeId, uint64 btcOut, bytes32 btcCommitment);
  event TradeCancelled(uint256 indexed tradeId, bytes32 refundCommitment);
  event TradeRetried(uint256 indexed tradeId, uint64 newLimitPx, uint128 newCloid, uint64 newDeadline);
  event AdapterConfigured(address indexed adapter);
  event MarketConfigured(uint64 usdcCoreToken, uint64 btcCoreToken, uint32 btcSpotAsset, uint64 btcNoteDenom);
  event AdminChanged(address indexed oldAdmin, address indexed newAdmin);

  modifier onlyAdmin() {
    require(msg.sender == admin, "only admin");
    _;
  }

  constructor(address _admin, HyperPrivacyPool _usdcPool, HyperPrivacyPool _btcPool) {
    require(_admin != address(0), "admin is zero address");
    require(address(_usdcPool) != address(0) && address(_btcPool) != address(0), "pool is zero address");
    admin = _admin;
    usdcPool = _usdcPool;
    btcPool = _btcPool;
    usdc = _usdcPool.token();
    btc = _btcPool.token();
  }

  // ----------------------------------------------------------------- config

  function configureAdapter(IHyperCore _adapter, address _coreAccount) external onlyAdmin {
    require(address(_adapter) != address(0) && _coreAccount != address(0), "zero address");
    adapter = _adapter;
    coreAccount = _coreAccount;
    emit AdapterConfigured(address(_adapter));
  }

  function configureMarket(
    uint64 _usdcCoreToken,
    uint64 _btcCoreToken,
    uint32 _btcSpotAsset,
    uint64 _btcNoteDenom,
    uint64 _defaultDeadlineSecs
  ) external onlyAdmin {
    require(_btcNoteDenom > 0, "denom is zero");
    usdcCoreToken = _usdcCoreToken;
    btcCoreToken = _btcCoreToken;
    btcSpotAsset = _btcSpotAsset;
    btcNoteDenom = _btcNoteDenom;
    defaultDeadlineSecs = _defaultDeadlineSecs;
    emit MarketConfigured(_usdcCoreToken, _btcCoreToken, _btcSpotAsset, _btcNoteDenom);
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
   * @notice Step 1+2: spend a shielded USDC note and open a HyperCore spot buy.
   * @param proof ZK proof for the USDC pool withdrawal (recipient must be this).
   * @param extData External data for the withdrawal; `recipient` must equal this
   *        controller and `extAmount` must be negative (a withdrawal).
   * @param p Trade parameters (slippage cap, deadline, note commitments).
   */
  function initiateTrade(
    ERCPool.Proof calldata proof,
    ERCPool.ExtData calldata extData,
    InitiateParams calldata p
  ) external nonReentrant returns (uint256 tradeId) {
    require(address(adapter) != address(0), "adapter unset");
    require(btcNoteDenom > 0, "market unset");
    require(extData.recipient == address(this), "recipient must be controller");
    require(extData.extAmount < 0, "must be a withdrawal");
    require(p.limitPx > 0, "limitPx is zero");
    require(p.btcCommitment != bytes32(0), "btc commitment unset");

    uint256 usdcIn = uint256(-extData.extAmount);

    // Verify + execute the shielded withdrawal. The pool transfers `usdcIn`
    // USDC to this controller and consumes the input nullifiers.
    uint256 balBefore = usdc.balanceOf(address(this));
    usdcPool.transact(proof, extData);
    require(usdc.balanceOf(address(this)) - balBefore == usdcIn, "unexpected usdc in");

    // Bridge USDC HyperEVM -> HyperCore (adapter holds funds, then bridges).
    usdc.safeTransfer(address(adapter), usdcIn);
    adapter.bridgeToCore(address(usdc), usdcCoreToken, usdcIn);

    uint64 deadline = p.deadline == 0 ? uint64(block.timestamp) + defaultDeadlineSecs : p.deadline;

    // Bounded market buy: IOC limit order, fixed base size = btcNoteDenom.
    uint128 cloid = adapter.placeSpotBuy(
      IHyperCore.SpotBuyParams({
        asset: btcSpotAsset,
        size: btcNoteDenom,
        limitPx: p.limitPx,
        tif: IHyperCore.Tif.Ioc,
        cloid: p.cloid
      })
    );

    tradeId = nextTradeId++;
    trades[tradeId] = Trade({
      initiator: msg.sender,
      usdcIn: usdcIn,
      size: btcNoteDenom,
      limitPx: p.limitPx,
      cloid: cloid,
      deadline: deadline,
      btcCommitment: p.btcCommitment,
      btcCommitment2: p.btcCommitment2,
      refundCommitment: p.refundCommitment,
      status: Status.Open,
      encryptedOutput1: p.encryptedOutput1,
      encryptedOutput2: p.encryptedOutput2
    });

    emit TradeInitiated(tradeId, usdcIn, btcNoteDenom, p.limitPx, cloid);
  }

  /**
   * @notice Step 3: settle a filled trade. Bridges exactly `size` BTC back into
   *         the BTC pool and mints the user's BTC note. Callable by anyone once
   *         the fill is observable (keeper-friendly).
   */
  function settleTrade(uint256 tradeId) external nonReentrant {
    Trade storage t = trades[tradeId];
    require(t.status == Status.Open, "trade not open");

    // Confirm the buy filled at least the fixed size on HyperCore.
    uint64 coreBtc = adapter.spotBalance(coreAccount, btcCoreToken);
    require(coreBtc >= t.size, "not filled");

    // Bridge the fixed BTC size back to the BTC pool (credits its ERC-20 balance).
    (, uint256 btcOut) = adapter.bridgeToEvm(btcCoreToken, t.size, address(btcPool));
    require(btcOut > 0, "bridge produced nothing");

    t.status = Status.Settled;

    // Mint the resulting BTC note into the BTC pool's tree.
    btcPool.traderMint(t.btcCommitment, t.btcCommitment2, t.encryptedOutput1, t.encryptedOutput2);

    emit TradeSettled(tradeId, t.size, t.btcCommitment);
  }

  /**
   * @notice Cancel an unfilled trade past its deadline and refund the USDC as a
   *         fresh shielded note in the USDC pool.
   */
  function cancelTrade(uint256 tradeId) external nonReentrant {
    Trade storage t = trades[tradeId];
    require(t.status == Status.Open, "trade not open");
    require(block.timestamp > t.deadline, "before deadline");
    require(t.refundCommitment != bytes32(0), "no refund commitment");

    // Order must not have filled (fixed-size IOC is all-or-nothing here).
    uint64 coreBtc = adapter.spotBalance(coreAccount, btcCoreToken);
    require(coreBtc < t.size, "already filled");

    adapter.cancelOrder(btcSpotAsset, t.cloid);

    // Bridge the unspent USDC back to the USDC pool and re-shield it.
    adapter.bridgeToEvm(usdcCoreToken, _usdcToCore(t.usdcIn), address(usdcPool));

    t.status = Status.Cancelled;
    // Refund note payload is recoverable from the user's locally-kept secret;
    // encrypted outputs are intentionally empty on the cancel path.
    usdcPool.traderMint(t.refundCommitment, bytes32(0), "", "");

    emit TradeCancelled(tradeId, t.refundCommitment);
  }

  /**
   * @notice Re-submit the spot buy for an open trade (e.g. raise the limit price
   *         after a non-fill). The USDC is already on HyperCore from initiate.
   */
  function retryTrade(
    uint256 tradeId,
    uint64 newLimitPx,
    uint64 newDeadline,
    uint128 newCloid
  ) external nonReentrant {
    Trade storage t = trades[tradeId];
    require(t.status == Status.Open, "trade not open");
    require(newLimitPx >= t.limitPx, "limit must not decrease");

    uint64 coreBtc = adapter.spotBalance(coreAccount, btcCoreToken);
    require(coreBtc < t.size, "already filled");

    uint128 cloid = adapter.placeSpotBuy(
      IHyperCore.SpotBuyParams({
        asset: btcSpotAsset,
        size: t.size,
        limitPx: newLimitPx,
        tif: IHyperCore.Tif.Ioc,
        cloid: newCloid
      })
    );

    t.limitPx = newLimitPx;
    t.cloid = cloid;
    t.deadline = newDeadline == 0 ? uint64(block.timestamp) + defaultDeadlineSecs : newDeadline;

    emit TradeRetried(tradeId, newLimitPx, cloid, t.deadline);
  }

  // --------------------------------------------------------------- helpers

  /// @dev Convert an EVM USDC amount to HyperCore core units via the adapter's
  ///      view of the round trip. We assume USDC uses the same scaling here; the
  ///      adapter performs the precise conversion when bridging.
  function _usdcToCore(uint256 amount) internal pure returns (uint64) {
    return uint64(amount);
  }
}
