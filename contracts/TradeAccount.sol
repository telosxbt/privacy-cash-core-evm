// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./hypercore/IHyperCore.sol";
import "./hypercore/CoreWriterLib.sol";

/**
 * @title TradeAccount
 * @notice A per-trade, isolated HyperCore account. {HyperTrader} deploys one (as
 *         an EIP-1167 clone) per trade, so the trade's USDC, spot order and bought
 *         asset all live on an account holding ONLY this trade's funds. That
 *         isolation is what makes delivery safe: an unfilled trade's account is
 *         empty, so it can never deliver/refund against another trade's fill.
 *
 * @dev Two execution paths, selected by whether `coreWriter` is set:
 *
 *        - PRODUCTION (coreWriter != 0): talks to HyperCore natively *as itself* —
 *          it deposits by transferring to the token system address (0x2000.. + id)
 *          and issues CoreWriter actions (0x333..3) directly, so msg.sender on the
 *          core side is THIS account. This is the only way isolation holds: a
 *          shared intermediary contract would collapse every trade onto one core
 *          account. Balances are read by {HyperTrader} via the {IHyperCore} read
 *          gateway (precompile-backed {HyperCoreView}).
 *
 *        - TEST (coreWriter == 0): routes through the typed {IHyperCore} `core`
 *          (MockHyperCore), which simulates HyperCore deterministically.
 *
 *      VENUE / ASYNC NOTES (production):
 *        - EVM vs HyperCore delivery is selected by the spot-send destination.
 *          Confirm the exact `toEvm` routing against the live spec (EVM delivery
 *          may target the token's system address rather than `dest` directly).
 *        - HyperCore credits deposits and fills asynchronously; {HyperTrader}'s
 *          two-step trade()/deliver() flow already accounts for this.
 */
contract TradeAccount {
  using SafeERC20 for IERC20;

  uint160 internal constant SYSTEM_ADDRESS_BASE = uint160(0x2000000000000000000000000000000000000000);

  address public owner; // the HyperTrader controller
  IHyperCore public core; // read gateway (and write gateway in test mode)
  address public coreWriter; // production CoreWriter (0x333..3); 0 => typed `core` writes
  bool private initialized;

  function initialize(address _owner, IHyperCore _core, address _coreWriter) external {
    require(!initialized, "already initialized");
    initialized = true;
    owner = _owner;
    core = _core;
    coreWriter = _coreWriter;
  }

  modifier onlyOwner() {
    require(msg.sender == owner, "not owner");
    _;
  }

  /// @dev System address that, when an ERC-20 is sent to it, credits this account's
  ///      HyperCore spot balance.
  function systemAddress(uint64 coreToken) public pure returns (address) {
    return address(SYSTEM_ADDRESS_BASE + uint160(coreToken));
  }

  /// @notice Deposit the held `token` into this account's HyperCore balance and
  ///         place the spot buy. Called once, in the trade tx.
  function fundAndBuy(
    IERC20 token,
    uint64 usdcCoreToken,
    uint256 amount,
    IHyperCore.SpotBuyParams calldata p
  ) external onlyOwner {
    if (coreWriter == address(0)) {
      // Test path: simulate via the typed gateway.
      token.forceApprove(address(core), amount);
      core.bridgeToCore(address(token), usdcCoreToken, amount);
      core.placeSpotBuy(p);
    } else {
      // Production path: deposit to the system address, then a raw CoreWriter order.
      token.safeTransfer(systemAddress(usdcCoreToken), amount);
      uint8 tif = p.tif == IHyperCore.Tif.Ioc
        ? CoreWriterLib.TIF_IOC
        : (p.tif == IHyperCore.Tif.Gtc ? CoreWriterLib.TIF_GTC : CoreWriterLib.TIF_ALO);
      CoreWriterLib.send(
        coreWriter,
        CoreWriterLib.encodeLimitOrder(p.asset, true, p.limitPx, p.size, false, tif, p.cloid)
      );
    }
  }

  /// @notice Send `amount` (wei units) of `coreToken` from this account to `dest`.
  ///         Used to deliver the bought asset and to refund USDC on cancel.
  ///         `toEvm` selects HyperEVM (ERC-20) vs HyperCore (spot account).
  function sendTo(address dest, uint64 coreToken, uint64 amount, bool toEvm) external onlyOwner {
    if (coreWriter == address(0)) {
      core.spotSend(dest, coreToken, amount, toEvm);
    } else {
      // Production: spot-send via CoreWriter. NOTE: confirm `toEvm` routing on the
      // live spec; EVM delivery may require sending to the token system address.
      address target = toEvm ? dest : dest;
      CoreWriterLib.send(coreWriter, CoreWriterLib.encodeSpotSend(target, coreToken, amount));
    }
  }
}
