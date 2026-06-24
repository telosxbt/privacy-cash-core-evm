// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./hypercore/IHyperCore.sol";

/**
 * @title TradeAccount
 * @notice A per-trade, isolated HyperCore account. {HyperTrader} deploys one
 *         (as a minimal-proxy clone) for every trade, so the trade's USDC, spot
 *         order and bought asset all live on an account that holds *only* this
 *         trade's funds. That isolation is what makes delivery safe: an unfilled
 *         trade's account is empty, so it can never deliver against another
 *         trade's fill.
 *
 * @dev Cloned via EIP-1167, so state is set in {initialize} (no constructor args).
 *      Only the owning {HyperTrader} can drive it.
 *
 *      PRODUCTION NOTE: for the isolation to hold on real HyperCore, the CoreWriter
 *      actions (place order, spot send) and the EVM->Core deposit must be issued
 *      with THIS contract as the sender. The {IHyperCore} calls below are the
 *      seam: a production gateway must execute them as the TradeAccount (e.g. raw
 *      CoreWriter calls from here), not via a shared intermediary.
 */
contract TradeAccount {
  using SafeERC20 for IERC20;

  address public owner; // the HyperTrader controller
  IHyperCore public core;
  bool private initialized;

  function initialize(address _owner, IHyperCore _core) external {
    require(!initialized, "already initialized");
    initialized = true;
    owner = _owner;
    core = _core;
  }

  modifier onlyOwner() {
    require(msg.sender == owner, "not owner");
    _;
  }

  /// @notice Deposit the held `token` into this account's HyperCore balance and
  ///         place the spot buy. Called once, in the trade tx.
  function fundAndBuy(
    IERC20 token,
    uint64 usdcCoreToken,
    uint256 amount,
    IHyperCore.SpotBuyParams calldata p
  ) external onlyOwner {
    token.forceApprove(address(core), amount);
    core.bridgeToCore(address(token), usdcCoreToken, amount);
    core.placeSpotBuy(p);
  }

  /// @notice Send `size` of the bought asset from this account to `dest`.
  ///         `toEvm` selects HyperEVM (ERC-20) vs HyperCore (spot account) delivery.
  function deliver(address dest, uint64 assetCoreToken, uint64 size, bool toEvm) external onlyOwner {
    core.spotSend(dest, assetCoreToken, size, toEvm);
  }
}
