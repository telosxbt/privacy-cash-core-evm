// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../hypercore/IHyperCore.sol";

/**
 * @title MockHyperCore (v1 — per-account gateway)
 * @notice Deterministic simulator of HyperCore that tracks balances PER CALLER,
 *         mirroring how HyperCore attributes a spot account to each address. Each
 *         {TradeAccount} therefore has its own isolated balances.
 *
 *           - bridgeToCore: pulls the caller's ERC-20 and credits the caller's core.
 *           - placeSpotBuy: an IOC buy that fills fully iff marketPx <= limitPx,
 *             debiting the caller's USDC and crediting the caller's asset balance.
 *           - spotSend: moves the caller's asset to `dest` — to HyperEVM (transfer
 *             the ERC-20 from the mock's inventory) or to `dest`'s core account.
 *           - spotBalance: synchronous per-account read.
 *
 *         Amounts are treated 1:1 between EVM and core (configurable sz->wei factor).
 */
contract MockHyperCore is IHyperCore {
  using SafeERC20 for IERC20;

  struct Tok {
    address evmToken;
    bool registered;
  }

  mapping(uint64 => Tok) public tokenOf;
  // account => coreToken => spot balance (wei units)
  mapping(address => mapping(uint64 => uint64)) public coreBalance;
  mapping(uint64 => uint64) public szFactor; // coreToken => 10^(weiDecimals-szDecimals); 0 => 1

  uint32 public assetSpot;
  uint64 public assetCoreToken;
  uint64 public usdcCoreToken;
  uint64 public marketPx; // USDC core units per 1 asset core unit

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
    IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
    creditedCore = uint64(amount);
    coreBalance[msg.sender][coreToken] += creditedCore;
  }

  /// @inheritdoc IHyperCore
  function placeSpotBuy(SpotBuyParams calldata p) external returns (uint128 cloid) {
    cloid = p.cloid;
    if (marketPx == 0 || marketPx > p.limitPx) {
      // Unfillable within the slippage cap: IOC rests with zero fill.
      return cloid;
    }
    uint64 cost = p.size * marketPx;
    require(coreBalance[msg.sender][usdcCoreToken] >= cost, "mock: insufficient usdc on core");
    coreBalance[msg.sender][usdcCoreToken] -= cost;
    coreBalance[msg.sender][assetCoreToken] += uint64(uint256(p.size) * _factor(assetCoreToken));
  }

  /// @inheritdoc IHyperCore
  function spotBalance(address account, uint64 coreToken) external view returns (uint64) {
    return coreBalance[account][coreToken];
  }

  /// @inheritdoc IHyperCore
  function spotSend(address dest, uint64 coreToken, uint64 amount, bool toEvm) external {
    require(coreBalance[msg.sender][coreToken] >= amount, "mock: insufficient core balance");
    coreBalance[msg.sender][coreToken] -= amount;
    if (toEvm) {
      Tok memory t = tokenOf[coreToken];
      require(t.registered, "mock: token");
      IERC20(t.evmToken).safeTransfer(dest, amount); // Core -> EVM: credit the ERC-20
    } else {
      coreBalance[dest][coreToken] += amount; // stays on HyperCore
    }
  }
}
