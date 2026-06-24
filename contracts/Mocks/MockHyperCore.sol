// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../hypercore/IHyperCore.sol";

/**
 * @title MockHyperCore (v1)
 * @notice Deterministic in-memory simulator of the HyperCore side used in tests.
 *
 *           - bridgeToCore: the caller has already transferred the ERC-20 to this
 *             mock (mirroring "tokens sent to the system address"); the mock
 *             credits the core balance and custodies the ERC-20.
 *           - placeSpotBuy: an IOC limit buy that fills fully iff the configured
 *             market price <= limitPx, debiting USDC core and crediting asset core.
 *           - bridgeToEvm: debits core and transfers the linked ERC-20 to the
 *             recipient from the mock's inventory (the trade proceeds).
 *
 *         Token amounts are treated 1:1 between EVM and core units (configurable
 *         sz->wei factor) to keep test arithmetic exact.
 */
contract MockHyperCore is IHyperCore {
  using SafeERC20 for IERC20;

  struct Tok {
    address evmToken;
    bool registered;
  }

  mapping(uint64 => Tok) public tokenOf;
  mapping(uint64 => uint64) public coreBalance; // coreToken => protocol core balance (wei units)
  mapping(uint64 => uint64) public szFactor; // coreToken => 10^(weiDecimals-szDecimals); 0 means 1 (1:1)

  uint32 public assetSpot;
  uint64 public assetCoreToken;
  uint64 public usdcCoreToken;
  uint64 public marketPx; // USDC core units paid per 1 asset core unit

  function register(uint64 coreToken, address evmToken) external {
    tokenOf[coreToken] = Tok(evmToken, true);
  }

  function setMarket(uint32 _assetSpot, uint64 _assetCoreToken, uint64 _usdcCoreToken, uint64 _px) external {
    assetSpot = _assetSpot;
    assetCoreToken = _assetCoreToken;
    usdcCoreToken = _usdcCoreToken;
    marketPx = _px;
  }

  function setPrice(uint64 _px) external {
    marketPx = _px;
  }

  /// @notice Configure the sz->wei scale for a token (default 1 = 1:1).
  function setSzFactor(uint64 coreToken, uint64 factor) external {
    szFactor[coreToken] = factor;
  }

  function _factor(uint64 coreToken) internal view returns (uint64) {
    uint64 f = szFactor[coreToken];
    return f == 0 ? 1 : f;
  }

  /// @inheritdoc IHyperCore
  function szToWei(uint64 coreToken, uint64 sz) external view returns (uint64) {
    return uint64(uint256(sz) * _factor(coreToken));
  }

  /// @inheritdoc IHyperCore
  function bridgeToCore(address token, uint64 coreToken, uint256 amount) external returns (uint64 creditedCore) {
    Tok memory t = tokenOf[coreToken];
    require(t.registered && t.evmToken == token, "mock: token");
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
    coreBalance[assetCoreToken] += uint64(uint256(p.size) * _factor(assetCoreToken));
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
}
