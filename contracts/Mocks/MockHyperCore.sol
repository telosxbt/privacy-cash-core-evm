// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../hypercore/IHyperCore.sol";

/**
 * @title MockHyperCore
 * @notice Deterministic in-memory simulator of the HyperCore side used in tests.
 *         It implements {IHyperCore} and models a single protocol "core account":
 *
 *           - bridgeToCore: the caller has already transferred the ERC-20 to this
 *             mock (mirroring "tokens sent to the system address"); the mock
 *             credits the core balance and custodies the ERC-20.
 *           - placeSpotBuy: an IOC limit buy that fills fully iff the configured
 *             market price <= limitPx, debiting USDC core and crediting BTC core.
 *             Price improvement (px < limitPx) leaves residual USDC on core.
 *           - bridgeToEvm: debits core and transfers the linked ERC-20 to the
 *             recipient from the mock's inventory.
 *
 *         Token amounts are treated 1:1 between EVM and core units to keep test
 *         arithmetic exact; production scaling lives in {HyperCoreAdapter}.
 */
contract MockHyperCore is IHyperCore {
  using SafeERC20 for IERC20;

  struct Tok {
    address evmToken;
    bool registered;
  }

  mapping(uint64 => Tok) public tokenOf;
  mapping(uint64 => uint64) public coreBalance; // coreToken => protocol core balance
  mapping(uint128 => uint64) public filledOf; // cloid => filled base size

  uint32 public btcAsset;
  uint64 public btcCoreToken;
  uint64 public usdcCoreToken;
  uint64 public marketPx; // USDC core units paid per 1 BTC core unit

  function register(uint64 coreToken, address evmToken) external {
    tokenOf[coreToken] = Tok(evmToken, true);
  }

  function setMarket(uint32 _btcAsset, uint64 _btcCoreToken, uint64 _usdcCoreToken, uint64 _px) external {
    btcAsset = _btcAsset;
    btcCoreToken = _btcCoreToken;
    usdcCoreToken = _usdcCoreToken;
    marketPx = _px;
  }

  function setPrice(uint64 _px) external {
    marketPx = _px;
  }

  /// @inheritdoc IHyperCore
  function bridgeToCore(address token, uint64 coreToken, uint256 amount) external returns (uint64 creditedCore) {
    Tok memory t = tokenOf[coreToken];
    require(t.registered && t.evmToken == token, "mock: token");
    // The trader transferred `amount` to this mock before calling (system-address sim).
    creditedCore = uint64(amount);
    coreBalance[coreToken] += creditedCore;
  }

  /// @inheritdoc IHyperCore
  function placeSpotBuy(SpotBuyParams calldata p) external returns (uint128 cloid) {
    cloid = p.cloid;
    if (marketPx == 0 || marketPx > p.limitPx) {
      // Unfillable within the slippage cap: IOC rests with zero fill.
      return cloid;
    }
    uint64 cost = p.size * marketPx;
    require(coreBalance[usdcCoreToken] >= cost, "mock: insufficient usdc on core");
    coreBalance[usdcCoreToken] -= cost;
    coreBalance[btcCoreToken] += p.size;
    filledOf[cloid] += p.size;
  }

  /// @inheritdoc IHyperCore
  function cancelOrder(uint32, uint128 cloid) external {
    // IOC orders don't rest; cancellation is a no-op beyond clearing tracking.
    delete filledOf[cloid];
  }

  /// @inheritdoc IHyperCore
  function bridgeToEvm(
    uint64 coreToken,
    uint64 coreAmount,
    address recipient
  ) external returns (address token, uint256 amount) {
    Tok memory t = tokenOf[coreToken];
    require(t.registered, "mock: token");
    require(coreBalance[coreToken] >= coreAmount, "mock: insufficient core balance");
    coreBalance[coreToken] -= coreAmount;
    amount = uint256(coreAmount);
    IERC20(t.evmToken).safeTransfer(recipient, amount);
    return (t.evmToken, amount);
  }

  /// @inheritdoc IHyperCore
  function spotBalance(address, uint64 coreToken) external view returns (uint64) {
    return coreBalance[coreToken];
  }

  /// @inheritdoc IHyperCore
  function spotPx(uint32) external view returns (uint64) {
    return marketPx;
  }

  /// @inheritdoc IHyperCore
  function orderStatus(uint128 cloid) external view returns (uint64 filledSize, uint64 openSize) {
    return (filledOf[cloid], 0);
  }
}
