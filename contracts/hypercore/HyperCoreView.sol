// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "./IHyperCore.sol";

/**
 * @title HyperCoreView
 * @notice Production READ gateway for {IHyperCore}. {HyperTrader} uses it to read
 *         a trade account's spot balance (to confirm a fill before delivery) and
 *         to convert order sizes to wei.
 *
 *         Reads are synchronous via the HyperCore spot-balance precompile. WRITES
 *         are intentionally unsupported here: orders / deposits / spot-sends must
 *         be issued *from each {TradeAccount}* (raw CoreWriter + system-address),
 *         not through a shared contract, or per-trade isolation would break.
 */
contract HyperCoreView is IHyperCore {
  /// @notice HyperCore spot-balance read precompile.
  address public constant SPOT_BALANCE_PRECOMPILE = 0x0000000000000000000000000000000000000801;

  struct TokenInfo {
    uint8 coreDecimals; // weiDecimals (typically 8)
    uint8 szDecimals; // order-size decimals (<= coreDecimals)
    bool registered;
  }

  mapping(uint64 => TokenInfo) public tokens;
  address public admin;

  constructor() {
    admin = msg.sender;
  }

  function transferAdmin(address _admin) external {
    require(msg.sender == admin, "not admin");
    require(_admin != address(0), "zero");
    admin = _admin;
  }

  /// @notice Register a token's decimals so {szToWei} can scale order sizes.
  function registerToken(uint64 coreToken, uint8 coreDecimals, uint8 szDecimals) external {
    require(msg.sender == admin, "not admin");
    require(szDecimals <= coreDecimals, "szDecimals");
    tokens[coreToken] = TokenInfo(coreDecimals, szDecimals, true);
  }

  /// @inheritdoc IHyperCore
  function spotBalance(address account, uint64 coreToken) external view returns (uint64) {
    (bool ok, bytes memory ret) = SPOT_BALANCE_PRECOMPILE.staticcall(abi.encode(account, coreToken));
    require(ok, "spotBalance");
    (uint64 total, , ) = abi.decode(ret, (uint64, uint64, uint64));
    return total;
  }

  /// @inheritdoc IHyperCore
  function szToWei(uint64 coreToken, uint64 sz) external view returns (uint64) {
    TokenInfo memory t = tokens[coreToken];
    require(t.registered, "token");
    return uint64(uint256(sz) * (10 ** (t.coreDecimals - t.szDecimals)));
  }

  // --- writes unsupported: issued raw from each TradeAccount ---

  function bridgeToCore(address, uint64, uint256) external pure returns (uint64) {
    revert("use raw CoreWriter");
  }

  function placeSpotBuy(SpotBuyParams calldata) external pure returns (uint128) {
    revert("use raw CoreWriter");
  }

  function spotSend(address, uint64, uint64, bool) external pure {
    revert("use raw CoreWriter");
  }
}
