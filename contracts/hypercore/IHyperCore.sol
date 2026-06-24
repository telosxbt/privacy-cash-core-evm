// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title IHyperCore (v1 — per-account gateway)
 * @notice Abstraction of the HyperCore side, keyed on the *caller's* core account.
 *         Every operation acts on `msg.sender`'s HyperCore spot account — exactly
 *         how HyperCore attributes balances and orders by address. The privacy
 *         protocol gives each trade its own {TradeAccount}, so each trade's USDC,
 *         order and bought asset live on an isolated account: one trade can never
 *         settle/deliver against another trade's fill.
 *
 *         Implementations:
 *           - MockHyperCore: deterministic simulator used in tests (tracks
 *             balances per msg.sender).
 *           - PRODUCTION: must be realized so each {TradeAccount}'s calls execute
 *             with the TradeAccount itself as the CoreWriter caller / system-address
 *             depositor (i.e. raw CoreWriter actions issued *from* the TradeAccount,
 *             not via a shared intermediary contract — a shared intermediary would
 *             collapse every trade onto one core account). See {CoreWriterLib} for
 *             the raw action encodings.
 *
 * @dev HyperCore works in 8-decimal "wei" amounts that differ from EVM ERC-20
 *      decimals; the implementation owns the conversion.
 */
interface IHyperCore {
  /// @notice Time-in-force for spot orders.
  enum Tif {
    Alo, // add-liquidity-only (post-only)
    Gtc, // good-til-cancelled
    Ioc // immediate-or-cancel (used for a bounded market buy)
  }

  struct SpotBuyParams {
    uint32 asset; // HyperCore spot asset id (e.g. the BTC/USDC pair index)
    uint64 size; // base size to buy, in order (sz) units
    uint64 limitPx; // max price (slippage cap); fill never exceeds this
    Tif tif; // typically Ioc
    uint128 cloid; // client order id
  }

  /**
   * @notice Deposit `amount` of `token` into the CALLER's HyperCore spot account.
   * @dev The caller must have approved the implementation (it pulls via
   *      transferFrom in the mock; in production the TradeAccount transfers to the
   *      token's system address). Credits `msg.sender`'s core balance.
   * @return creditedCore Amount credited on HyperCore, in core units.
   */
  function bridgeToCore(address token, uint64 coreToken, uint256 amount) external returns (uint64 creditedCore);

  /// @notice Place a spot buy on the CALLER's account.
  /// @return cloid The client order id.
  function placeSpotBuy(SpotBuyParams calldata params) external returns (uint128 cloid);

  /**
   * @notice Send `amount` of `coreToken` from the CALLER's account to `dest`.
   * @param toEvm If true, bridge to `dest`'s EVM-linked address (credits the
   *        ERC-20 on HyperEVM). If false, keep it on HyperCore, crediting `dest`'s
   *        spot account. This is how the user chooses where to receive the asset.
   */
  function spotSend(address dest, uint64 coreToken, uint64 amount, bool toEvm) external;

  /// @notice Spot balance (core units) of `account` for `coreToken`. Synchronous read.
  function spotBalance(address account, uint64 coreToken) external view returns (uint64);

  /// @notice Convert an order base size (`sz`) into a core (wei) amount for `coreToken`.
  function szToWei(uint64 coreToken, uint64 sz) external view returns (uint64);
}
