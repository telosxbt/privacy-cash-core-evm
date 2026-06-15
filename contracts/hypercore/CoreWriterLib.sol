// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title CoreWriterLib
 * @notice Encodes HyperCore "raw actions" for the native CoreWriter system
 *         contract at 0x3333333333333333333333333333333333333333.
 *
 * @dev Action payload layout (encoding version 1):
 *        bytes[0]      = 0x01            (encoding version)
 *        bytes[1..3]   = action id       (3 bytes, big-endian)
 *        bytes[4..]    = abi.encode(...) (action-specific tuple)
 *
 *      Action ids used here:
 *        1  -> limit order
 *        10 -> cancel order by oid
 *        11 -> cancel order by cloid
 *        6  -> spot send
 *
 *      Tif encoding for limit orders: 1 = Alo, 2 = Gtc, 3 = Ioc.
 *
 *      These layouts follow the public Hyperliquid HyperEVM/CoreWriter spec.
 *      Because L1 encodings can evolve, {HyperCoreAdapter} keeps the CoreWriter
 *      address configurable and all amounts are validated upstream.
 */
interface ICoreWriter {
  function sendRawAction(bytes calldata data) external;
}

library CoreWriterLib {
  address internal constant CORE_WRITER = 0x3333333333333333333333333333333333333333;

  uint24 internal constant ACTION_LIMIT_ORDER = 1;
  uint24 internal constant ACTION_SPOT_SEND = 6;
  uint24 internal constant ACTION_CANCEL_BY_OID = 10;
  uint24 internal constant ACTION_CANCEL_BY_CLOID = 11;

  uint8 internal constant TIF_ALO = 1;
  uint8 internal constant TIF_GTC = 2;
  uint8 internal constant TIF_IOC = 3;

  function _header(uint24 actionId) private pure returns (bytes memory) {
    // 0x01 version byte followed by the 3-byte action id.
    return abi.encodePacked(uint8(1), bytes3(actionId));
  }

  /// @dev Encode a spot/perp limit order action.
  function encodeLimitOrder(
    uint32 asset,
    bool isBuy,
    uint64 limitPx,
    uint64 sz,
    bool reduceOnly,
    uint8 encodedTif,
    uint128 cloid
  ) internal pure returns (bytes memory) {
    return
      abi.encodePacked(
        _header(ACTION_LIMIT_ORDER),
        abi.encode(asset, isBuy, limitPx, sz, reduceOnly, encodedTif, cloid)
      );
  }

  /// @dev Encode a cancel-by-client-order-id action.
  function encodeCancelByCloid(uint32 asset, uint128 cloid) internal pure returns (bytes memory) {
    return abi.encodePacked(_header(ACTION_CANCEL_BY_CLOID), abi.encode(asset, cloid));
  }

  /// @dev Encode a spot send (used to push a core balance to a destination/system address).
  function encodeSpotSend(address destination, uint64 token, uint64 weiAmount) internal pure returns (bytes memory) {
    return abi.encodePacked(_header(ACTION_SPOT_SEND), abi.encode(destination, token, weiAmount));
  }

  /// @dev Submit a pre-encoded action to the CoreWriter system contract.
  function send(address coreWriter, bytes memory data) internal {
    ICoreWriter(coreWriter).sendRawAction(data);
  }
}
