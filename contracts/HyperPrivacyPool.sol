// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "./ERCPool.sol";

/**
 * @title HyperPrivacyPool
 * @notice A single-asset privacy pool (identical deposit/withdraw/ZK semantics
 *         to {ERCPool}) extended with two hooks used by the {HyperTrader}
 *         controller to run privacy-preserving HyperCore spot trades:
 *
 *           - The controller spends a user's note via the normal {transact}
 *             withdrawal path (recipient = controller) to pull funds out for a
 *             trade. No new code is needed for that; it is a standard withdraw.
 *
 *           - {traderMint} lets the controller insert settlement commitments
 *             (the resulting asset note) into this pool's Merkle tree, exactly
 *             like the output side of a deposit, but funded by tokens the
 *             controller has already bridged into this pool.
 *
 * @dev Two instances are deployed: one bound to USDC (the "spend" side) and one
 *      bound to BTC (the "claim" side). Keeping a separate tree + nullifier set
 *      per asset means the on-chain logic never needs to read the circuit's
 *      private `mintAddress`, so the existing Verifier2 is reused unchanged.
 *
 *      TRUST MODEL: {traderMint} is a privileged operation. The controller is
 *      trusted to mint a settlement note only after the backing asset has been
 *      bridged into this pool (see {HyperTrader.settleTrade}). This is the same
 *      trust surface as the existing `admin` (which can already upgrade the
 *      proxy). The controller contract is deterministic and auditable.
 */
contract HyperPrivacyPool is ERCPool {
  /// @notice Controller authorised to mint settlement notes.
  address public trader;

  event TraderConfigured(address indexed trader);
  event SettlementMinted(bytes32 indexed commitment1, bytes32 indexed commitment2);

  modifier onlyTrader() {
    require(msg.sender == trader, "only trader");
    _;
  }

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(
    Verifier2 _verifier2,
    uint32 _levels,
    address _hasher,
    IERC20 _token
  ) ERCPool(_verifier2, _levels, _hasher, _token) {}

  /// @notice Set (or rotate) the controller. Admin-gated.
  function configureTrader(address _trader) external onlyAdmin {
    require(_trader != address(0), "trader is zero address");
    trader = _trader;
    emit TraderConfigured(_trader);
  }

  /**
   * @notice Insert a pair of settlement commitments into the tree.
   * @dev Mirrors the output side of {transact}. Callable only by the controller,
   *      which must have already transferred the backing asset into this pool.
   *      The commitments themselves are computed off-chain by the user (the
   *      resulting-asset note + an empty change note), preserving privacy: the
   *      pool learns nothing linking the note to any prior deposit.
   */
  function traderMint(
    bytes32 commitment1,
    bytes32 commitment2,
    bytes calldata encryptedOutput1,
    bytes calldata encryptedOutput2
  ) external onlyTrader nonReentrant whenNotPaused {
    require(
      encryptedOutput1.length <= MAX_ENCRYPTED_OUTPUT_SIZE && encryptedOutput2.length <= MAX_ENCRYPTED_OUTPUT_SIZE,
      "Encrypted output too large"
    );
    require(
      uint256(commitment1) < FIELD_SIZE && uint256(commitment2) < FIELD_SIZE,
      "commitment outside field"
    );

    _insert(commitment1, commitment2);
    emit NewCommitment(commitment1, nextIndex - 2, encryptedOutput1);
    emit NewCommitment(commitment2, nextIndex - 1, encryptedOutput2);
    emit SettlementMinted(commitment1, commitment2);
  }
}
