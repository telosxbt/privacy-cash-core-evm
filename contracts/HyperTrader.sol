// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "./ERCPool.sol";
import "./hypercore/IHyperCore.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title HyperTrader (v1 — buy-only, fire-and-forget)
 * @notice Privacy-preserving spot buys on HyperEVM/HyperCore.
 *
 *         One transaction does the whole trade:
 *
 *           1. The user (or a relayer on their behalf) submits a ZK withdrawal
 *              proof against the USDC pool with recipient = this controller. The
 *              pool verifies the proof and releases a user-chosen amount of USDC,
 *              breaking the link to the original depositor — exactly like a normal
 *              shielded withdrawal.
 *
 *           2. The controller bridges the USDC to HyperCore, places an IOC spot
 *              buy for `size` of the chosen asset, and immediately pushes the
 *              bought asset to a user-supplied `recipient` address.
 *
 *         There is NO settlement step and NO on-chain fill bookkeeping. The two
 *         CoreWriter actions (buy, then spot-send to `recipient`) are queued in
 *         this single transaction; HyperCore executes the IOC fill and then the
 *         send. The privacy property is "shielded USDC in, transparent asset out
 *         to a fresh address" — the output is public, but unlinkable to the USDC
 *         depositor.
 *
 *         RELAYER MODEL: the call is permissionless and the withdrawal carries a
 *         `fee` / `feeRecipient`, so a relayer can submit the tx and pay the gas
 *         (in HYPE) while being reimbursed in USDC out of the user's note. The
 *         user therefore never sends a transaction from a linked wallet.
 *
 *         CAVEAT (async): on production HyperCore the buy fills asynchronously, so
 *         the proceeds-send of `size` succeeds only if the order fills for at
 *         least `size`. v1 deliberately does not guard this on-chain; pick a
 *         `limitPx` with enough depth. A future version can re-introduce a
 *         settlement/refund path (see the v2 branch).
 */
contract HyperTrader is ReentrancyGuard {
  using SafeERC20 for IERC20;

  address public admin;
  address public pendingAdmin;

  IHyperCore public adapter;
  ERCPool public immutable usdcPool; // quote pool: the user spends shielded USDC
  IERC20 public immutable usdc;

  uint64 public usdcCoreToken; // HyperCore spot token id for USDC
  uint64 public defaultDeadlineSecs; // reserved for future use; unused in v1 IOC flow

  event AdapterConfigured(address indexed adapter, uint64 usdcCoreToken);
  event AdminChanged(address indexed oldAdmin, address indexed newAdmin);
  event Traded(
    address indexed recipient,
    uint32 asset,
    uint64 assetCoreToken,
    uint64 size,
    uint64 limitPx,
    uint128 cloid,
    uint256 usdcIn
  );

  struct TradeParams {
    uint32 asset; // HyperCore spot asset id (e.g. BTC/USDC pair index)
    uint64 assetCoreToken; // core token id of the asset being bought
    uint64 size; // base size to buy (sz units)
    uint64 limitPx; // slippage cap (core px units)
    uint128 cloid; // client order id
    address recipient; // EVM address that receives the bought asset
  }

  modifier onlyAdmin() {
    require(msg.sender == admin, "only admin");
    _;
  }

  constructor(address _admin, ERCPool _usdcPool) {
    require(_admin != address(0), "admin is zero address");
    require(address(_usdcPool) != address(0), "pool is zero address");
    admin = _admin;
    usdcPool = _usdcPool;
    usdc = _usdcPool.token();
  }

  // ----------------------------------------------------------------- config

  function configureAdapter(IHyperCore _adapter, uint64 _usdcCoreToken, uint64 _defaultDeadlineSecs)
    external
    onlyAdmin
  {
    require(address(_adapter) != address(0), "zero address");
    adapter = _adapter;
    usdcCoreToken = _usdcCoreToken;
    defaultDeadlineSecs = _defaultDeadlineSecs;
    emit AdapterConfigured(address(_adapter), _usdcCoreToken);
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
   * @notice Spend a shielded USDC note and buy `p.size` of `p.asset`, delivered
   *         straight to `p.recipient`. One tx, no settlement.
   * @param proof ZK proof for the USDC pool withdrawal (recipient must be this).
   * @param extData External data; `recipient` must equal this controller and
   *        `extAmount` must be negative (a withdrawal). `fee`/`feeRecipient` pay
   *        the relayer in USDC.
   * @param p Trade parameters (asset, size, slippage cap, destination address).
   */
  function trade(
    ERCPool.Proof calldata proof,
    ERCPool.ExtData calldata extData,
    TradeParams calldata p
  ) external nonReentrant {
    require(address(adapter) != address(0), "adapter unset");
    require(extData.recipient == address(this), "recipient must be controller");
    require(extData.extAmount < 0, "must be a withdrawal");
    require(p.limitPx > 0, "limitPx is zero");
    require(p.size > 0, "size is zero");
    require(p.recipient != address(0), "recipient is zero");

    uint256 usdcIn = uint256(-extData.extAmount);

    // Verify + execute the shielded withdrawal. The pool transfers `usdcIn` USDC
    // to this controller and consumes the input nullifiers.
    uint256 balBefore = usdc.balanceOf(address(this));
    usdcPool.transact(proof, extData);
    require(usdc.balanceOf(address(this)) - balBefore == usdcIn, "unexpected usdc in");

    // Bridge USDC HyperEVM -> HyperCore (adapter holds funds, then bridges).
    usdc.safeTransfer(address(adapter), usdcIn);
    adapter.bridgeToCore(address(usdc), usdcCoreToken, usdcIn);

    // Bounded market buy (IOC), then push the bought size straight to the user.
    adapter.placeSpotBuy(
      IHyperCore.SpotBuyParams({
        asset: p.asset,
        size: p.size,
        limitPx: p.limitPx,
        tif: IHyperCore.Tif.Ioc,
        cloid: p.cloid
      })
    );
    adapter.bridgeToEvm(p.assetCoreToken, _coreSize(p.assetCoreToken, p.size), p.recipient);

    emit Traded(p.recipient, p.asset, p.assetCoreToken, p.size, p.limitPx, p.cloid, usdcIn);
  }

  // --------------------------------------------------------------- helpers

  /// @dev Convert an order base size (`sz`) into a HyperCore core (wei) amount.
  function _coreSize(uint64 assetCoreToken, uint64 sz) internal view returns (uint64) {
    return adapter.szToWei(assetCoreToken, sz);
  }
}
