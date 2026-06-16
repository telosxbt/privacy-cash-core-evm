// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./IHyperCore.sol";
import "./CoreWriterLib.sol";

/**
 * @title HyperCoreAdapter
 * @notice Production {IHyperCore} implementation that bridges between HyperEVM
 *         and HyperCore using the native mechanisms:
 *
 *           - EVM -> Core: transfer the linked ERC-20 to the token's HyperCore
 *             "system address" (0x2000..0000 + tokenIndex). The deposit is
 *             credited to the *sender's* HyperCore spot account. Because the
 *             trader delegates here via delegatecall semantics is NOT used, this
 *             adapter is intended to be deployed as the trader's HyperCore agent
 *             (the trader transfers tokens into the adapter first, then bridges).
 *
 *           - Spot trade: submit a CoreWriter limit order (IOC for a bounded
 *             market buy) via 0x333..3.
 *
 *           - Core -> EVM: CoreWriter spot send to the destination's EVM-linked
 *             address, which credits the ERC-20 on HyperEVM.
 *
 * @dev Read precompiles and the token system-address base are configurable in
 *      the constructor so the adapter can track spec changes without a redeploy
 *      of the privacy pools. HyperCore uses 8-decimal core units; the adapter
 *      converts using each token's `evmDecimals`.
 *
 *      This adapter is a faithful, best-effort encoding of the public spec. The
 *      protocol's invariants are enforced in {HyperTrader}; tests exercise the
 *      same trader against MockHyperCore.
 */
contract HyperCoreAdapter is IHyperCore {
  using SafeERC20 for IERC20;
  using CoreWriterLib for *;

  /// @notice HyperCore spot-balance read precompile.
  address public constant SPOT_BALANCE_PRECOMPILE = 0x0000000000000000000000000000000000000801;
  /// @notice HyperCore spot price read precompile (best-effort; configurable fallback).
  address public constant SPOT_PX_PRECOMPILE = 0x0000000000000000000000000000000000000808;
  /// @notice Base of the per-token EVM->Core system addresses.
  uint160 internal constant SYSTEM_ADDRESS_BASE = uint160(0x2000000000000000000000000000000000000000);

  address public immutable coreWriter;
  address public owner; // the HyperTrader allowed to drive this adapter (move funds, trade)
  address public admin; // config role: links tokens / rotates roles (no fund access)

  struct TokenInfo {
    address evmToken; // ERC-20 on HyperEVM
    uint64 coreToken; // HyperCore spot token id
    uint8 evmDecimals; // ERC-20 decimals
    uint8 coreDecimals; // HyperCore wei decimals (typically 8)
    bool registered;
  }

  // coreToken id => token linkage
  mapping(uint64 => TokenInfo) public tokens;

  modifier onlyOwner() {
    require(msg.sender == owner, "adapter: not owner");
    _;
  }

  modifier onlyAdmin() {
    require(msg.sender == admin, "adapter: not admin");
    _;
  }

  /**
   * @param _coreWriter HyperCore CoreWriter system contract (0x333..3 on HyperEVM).
   * @param _owner The HyperTrader controller allowed to move funds / place orders.
   * @dev The deployer becomes `admin` (config role) so it can link tokens before
   *      and after the trader is live, without ever gaining fund-moving rights.
   */
  constructor(address _coreWriter, address _owner) {
    require(_coreWriter != address(0) && _owner != address(0), "adapter: zero addr");
    coreWriter = _coreWriter;
    owner = _owner;
    admin = msg.sender;
  }

  /// @notice Rotate the fund-moving owner (the HyperTrader controller). Admin-gated.
  function transferOwner(address _owner) external onlyAdmin {
    require(_owner != address(0), "adapter: zero addr");
    owner = _owner;
  }

  /// @notice Rotate the config admin. Admin-gated.
  function transferAdmin(address _admin) external onlyAdmin {
    require(_admin != address(0), "adapter: zero addr");
    admin = _admin;
  }

  /// @notice Link an EVM ERC-20 to its HyperCore spot token id. Config-only, no
  ///         fund access, so it is gated on `admin` rather than `owner`.
  function registerToken(
    address evmToken,
    uint64 coreToken,
    uint8 evmDecimals,
    uint8 coreDecimals
  ) external onlyAdmin {
    tokens[coreToken] = TokenInfo(evmToken, coreToken, evmDecimals, coreDecimals, true);
  }

  /// @dev System address that, when an ERC-20 is sent to it, credits HyperCore spot.
  function systemAddress(uint64 coreToken) public pure returns (address) {
    return address(SYSTEM_ADDRESS_BASE + uint160(coreToken));
  }

  function _toCore(TokenInfo memory t, uint256 evmAmount) internal pure returns (uint64) {
    if (t.evmDecimals >= t.coreDecimals) {
      return uint64(evmAmount / (10 ** (t.evmDecimals - t.coreDecimals)));
    }
    return uint64(evmAmount * (10 ** (t.coreDecimals - t.evmDecimals)));
  }

  function _toEvm(TokenInfo memory t, uint64 coreAmount) internal pure returns (uint256) {
    if (t.evmDecimals >= t.coreDecimals) {
      return uint256(coreAmount) * (10 ** (t.evmDecimals - t.coreDecimals));
    }
    return uint256(coreAmount) / (10 ** (t.coreDecimals - t.evmDecimals));
  }

  /// @inheritdoc IHyperCore
  function bridgeToCore(
    address token,
    uint64 coreToken,
    uint256 amount
  ) external onlyOwner returns (uint64 creditedCore) {
    TokenInfo memory t = tokens[coreToken];
    require(t.registered && t.evmToken == token, "adapter: token");
    // Owner must have transferred `amount` of `token` to this adapter beforehand.
    IERC20(token).safeTransfer(systemAddress(coreToken), amount);
    creditedCore = _toCore(t, amount);
  }

  /// @inheritdoc IHyperCore
  function placeSpotBuy(SpotBuyParams calldata params) external onlyOwner returns (uint128 cloid) {
    uint8 tif = params.tif == Tif.Ioc
      ? CoreWriterLib.TIF_IOC
      : (params.tif == Tif.Gtc ? CoreWriterLib.TIF_GTC : CoreWriterLib.TIF_ALO);
    bytes memory action = CoreWriterLib.encodeLimitOrder(
      params.asset,
      true, // isBuy
      params.limitPx,
      params.size,
      false, // reduceOnly
      tif,
      params.cloid
    );
    CoreWriterLib.send(coreWriter, action);
    return params.cloid;
  }

  /// @inheritdoc IHyperCore
  function cancelOrder(uint32 asset, uint128 cloid) external onlyOwner {
    CoreWriterLib.send(coreWriter, CoreWriterLib.encodeCancelByCloid(asset, cloid));
  }

  /// @inheritdoc IHyperCore
  function bridgeToEvm(
    uint64 coreToken,
    uint64 coreAmount,
    address recipient
  ) external onlyOwner returns (address token, uint256 amount) {
    TokenInfo memory t = tokens[coreToken];
    require(t.registered, "adapter: token");
    // A spot send on HyperCore to the recipient's linked EVM address credits the ERC-20.
    CoreWriterLib.send(coreWriter, CoreWriterLib.encodeSpotSend(recipient, coreToken, coreAmount));
    return (t.evmToken, _toEvm(t, coreAmount));
  }

  /// @inheritdoc IHyperCore
  function spotBalance(address account, uint64 coreToken) external view returns (uint64) {
    (bool ok, bytes memory ret) = SPOT_BALANCE_PRECOMPILE.staticcall(abi.encode(account, coreToken));
    require(ok, "adapter: spotBalance");
    (uint64 total, , ) = abi.decode(ret, (uint64, uint64, uint64));
    return total;
  }

  /// @inheritdoc IHyperCore
  function spotPx(uint32 asset) external view returns (uint64) {
    (bool ok, bytes memory ret) = SPOT_PX_PRECOMPILE.staticcall(abi.encode(asset));
    require(ok, "adapter: spotPx");
    return abi.decode(ret, (uint64));
  }

  /// @inheritdoc IHyperCore
  /// @dev On-chain CoreWriter gives no synchronous fill receipt; order status is
  ///      derived off-chain or via spot balance deltas. The production adapter
  ///      returns (0,0) and the trader settles against realized spot balances.
  function orderStatus(uint128) external pure returns (uint64, uint64) {
    return (0, 0);
  }
}
