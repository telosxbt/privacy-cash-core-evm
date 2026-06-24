// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title IHyperCore (v1)
 * @notice Minimal adapter interface the privacy protocol uses to talk to
 *         HyperCore from HyperEVM. v1 is buy-only and "fire-and-forget": the
 *         controller spends a shielded note, bridges to HyperCore, places a spot
 *         buy, and pushes the bought asset straight to a user-chosen address.
 *         There is no settlement / fill bookkeeping on-chain.
 *
 *         Concrete implementations:
 *           - {HyperCoreAdapter}: production adapter (CoreWriter 0x333..3).
 *           - MockHyperCore: deterministic simulator used in tests.
 *
 * @dev HyperCore works in 8-decimal "wei" amounts that differ from the EVM ERC-20
 *      decimals. Amount conversion is the adapter's responsibility.
 */
interface IHyperCore {
  /// @notice Time-in-force for spot orders.
  enum Tif {
    Alo, // add-liquidity-only (post-only)
    Gtc, // good-til-cancelled
    Ioc // immediate-or-cancel (used for "market-like" buys with a price cap)
  }

  struct SpotBuyParams {
    uint32 asset; // HyperCore spot asset id (e.g. the BTC/USDC spot pair index)
    uint64 size; // base size to buy, in core units (e.g. BTC szDecimals)
    uint64 limitPx; // max price (slippage protection); fill never exceeds this
    Tif tif; // typically Ioc for a bounded market buy
    uint128 cloid; // client order id, used for tracking
  }

  /**
   * @notice Move an EVM ERC-20 balance held by `msg.sender` into the HyperCore
   *         spot account controlled by `msg.sender`.
   * @return creditedCore Amount credited on HyperCore, in core units.
   */
  function bridgeToCore(address token, uint64 coreToken, uint256 amount) external returns (uint64 creditedCore);

  /**
   * @notice Move a HyperCore spot balance to the EVM, crediting `recipient` with
   *         the linked ERC-20. Used to push a trade's proceeds to the user.
   * @return token EVM ERC-20 address that was credited.
   * @return amount Amount credited in EVM ERC-20 units.
   */
  function bridgeToEvm(
    uint64 coreToken,
    uint64 coreAmount,
    address recipient
  ) external returns (address token, uint256 amount);

  /// @notice Place a spot buy order on HyperCore.
  /// @return cloid The client order id assigned to the order.
  function placeSpotBuy(SpotBuyParams calldata params) external returns (uint128 cloid);

  /**
   * @notice Convert an order base size (`sz`) into a core (wei) amount for `coreToken`.
   * @dev Order sizes and spot balances use different decimal scales; this is the
   *      single conversion needed before pushing a bought size back to the EVM.
   */
  function szToWei(uint64 coreToken, uint64 sz) external view returns (uint64);
}
