// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./IHyperCore.sol";
import "./CoreWriterLib.sol";

/**
 * @title HyperCoreAdapter (v1)
 * @notice Production {IHyperCore} implementation that bridges between HyperEVM
 *         and HyperCore using the native mechanisms:
 *
 *           - EVM -> Core: transfer the linked ERC-20 to the token's HyperCore
 *             system address (0x2000..0000 + tokenIndex), crediting the sender's
 *             HyperCore spot account.
 *           - Spot buy: submit a CoreWriter IOC limit order via 0x333..3.
 *           - Core -> EVM: CoreWriter spot send to the recipient's EVM-linked
 *             address, crediting the ERC-20 on HyperEVM.
 *
 * @dev v1 is buy-only and does no fill bookkeeping: {HyperTrader} queues the buy
 *      and the proceeds-send in one transaction and never reads order status.
 */
contract HyperCoreAdapter is IHyperCore {
  using SafeERC20 for IERC20;
  using CoreWriterLib for *;

  /// @notice Base of the per-token EVM->Core system addresses.
  uint160 internal constant SYSTEM_ADDRESS_BASE = uint160(0x2000000000000000000000000000000000000000);

  address public immutable coreWriter;
  address public owner; // the HyperTrader allowed to drive this adapter (move funds, trade)
  address public admin; // config role: links tokens / rotates roles (no fund access)

  struct TokenInfo {
    address evmToken; // ERC-20 on HyperEVM
    uint64 coreToken; // HyperCore spot token id
    uint8 evmDecimals; // ERC-20 decimals
    uint8 coreDecimals; // HyperCore wei decimals (weiDecimals, typically 8)
    uint8 szDecimals; // HyperCore order-size decimals (<= coreDecimals)
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
   * @dev The deployer becomes `admin` (config role) so it can link tokens without
   *      ever gaining fund-moving rights.
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

  /// @notice Link an EVM ERC-20 to its HyperCore spot token id. Config-only.
  function registerToken(
    address evmToken,
    uint64 coreToken,
    uint8 evmDecimals,
    uint8 coreDecimals,
    uint8 szDecimals
  ) external onlyAdmin {
    require(szDecimals <= coreDecimals, "adapter: szDecimals");
    tokens[coreToken] = TokenInfo(evmToken, coreToken, evmDecimals, coreDecimals, szDecimals, true);
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
  function szToWei(uint64 coreToken, uint64 sz) external view returns (uint64) {
    TokenInfo memory t = tokens[coreToken];
    require(t.registered, "adapter: token");
    // szDecimals <= coreDecimals enforced at registration => lossless upscale.
    return uint64(uint256(sz) * (10 ** (t.coreDecimals - t.szDecimals)));
  }
}
