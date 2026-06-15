// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title IHyperCore
 * @notice Minimal adapter interface the privacy protocol uses to talk to
 *         HyperCore from HyperEVM. Concrete implementations:
 *           - {HyperCoreAdapter}: production adapter that calls the native
 *             CoreWriter (0x333...3) and the read precompiles (0x800..).
 *           - MockHyperCore: deterministic simulator used in tests.
 *
 *         Routing every HyperCore interaction through this interface keeps the
 *         trading/privacy logic (HyperTrader) testable without a live L1.
 *
 * @dev HyperCore works in 8-decimal "wei" amounts ("szDecimals"/"weiDecimals")
 *      that differ from the EVM ERC-20 decimals. Amount conversion is the
 *      responsibility of the adapter implementation; the trader speaks in EVM
 *      ERC-20 units and HyperCore core-units only where explicitly typed `uint64`.
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
    uint128 cloid; // client order id, used for tracking / cancellation
  }

  /**
   * @notice Move an EVM ERC-20 balance held by `msg.sender` into the HyperCore
   *         spot account controlled by `msg.sender`.
   * @param token EVM ERC-20 address (must be a HyperCore-linked token).
   * @param coreToken HyperCore spot token id linked to `token`.
   * @param amount Amount in EVM ERC-20 units.
   * @return creditedCore Amount credited on HyperCore, in core units.
   */
  function bridgeToCore(address token, uint64 coreToken, uint256 amount) external returns (uint64 creditedCore);

  /**
   * @notice Move a HyperCore spot balance back to the EVM, crediting `recipient`
   *         with the linked ERC-20.
   * @param coreToken HyperCore spot token id to withdraw.
   * @param coreAmount Amount in core units.
   * @param recipient EVM address to credit with the ERC-20.
   * @return token EVM ERC-20 address that was credited.
   * @return amount Amount credited in EVM ERC-20 units.
   */
  function bridgeToEvm(
    uint64 coreToken,
    uint64 coreAmount,
    address recipient
  ) external returns (address token, uint256 amount);

  /**
   * @notice Place a spot buy order on HyperCore.
   * @return cloid The client order id assigned to the order.
   */
  function placeSpotBuy(SpotBuyParams calldata params) external returns (uint128 cloid);

  /// @notice Cancel a previously placed order by its client order id.
  function cancelOrder(uint32 asset, uint128 cloid) external;

  /// @notice Spot balance (core units) of `account` for `coreToken`.
  function spotBalance(address account, uint64 coreToken) external view returns (uint64);

  /// @notice Current spot oracle/mid price for `asset` (core px units).
  function spotPx(uint32 asset) external view returns (uint64);

  /// @notice Fill status of an order: filled base size and remaining open size.
  function orderStatus(uint128 cloid) external view returns (uint64 filledSize, uint64 openSize);
}
