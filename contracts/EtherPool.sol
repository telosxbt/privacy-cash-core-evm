// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

import "./Verifier2.sol";
import "./MerkleTreeWithHistory.sol";
import "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

// Pool for Ether transactions.
contract EtherPool is MerkleTreeWithHistory, UUPSUpgradeable {
  uint256 private constant _NOT_ENTERED = 1;
  uint256 private constant _ENTERED = 2;
  uint256 private _status;

  modifier nonReentrant() {
    require(_status != _ENTERED, "ReentrancyGuard: reentrant call");
    _status = _ENTERED;
    _;
    _status = _NOT_ENTERED;
  }
  int256 public constant MAX_EXT_AMOUNT = 2**248;
  uint256 public constant MAX_FEE = 2**248;

  Verifier2 public immutable verifier2;
  address public admin;
  address public pendingAdmin;

  uint256 public maximumDepositAmount;
  mapping(bytes32 => bool) public nullifierHashes;

  // no need to put tokenAddress here, since it's one contract per token
  struct ExtData {
    address recipient;
    int256 extAmount;
    address feeRecipient;
    uint256 fee;
    bytes encryptedOutput1;
    bytes encryptedOutput2;
  }

  struct Proof {
    uint[2] pA;
    uint[2][2] pB;
    uint[2] pC;
    bytes32 root;
    bytes32[2] inputNullifiers;
    bytes32[2] outputCommitments;
    uint256 publicAmount;
    bytes32 extDataHash;
  }

  struct Account {
    address owner;
    bytes publicKey;
  }

  event NewCommitment(bytes32 commitment, uint256 index, bytes encryptedOutput);
  event NewNullifier(bytes32 nullifier);
  event PublicKey(address indexed owner, bytes key);
  event LimitsConfigured(uint256 maximumDepositAmount);
  event AdminChanged(address indexed oldAdmin, address indexed newAdmin);

  modifier onlyAdmin() {
    require(msg.sender == admin, "only admin");
    _;
  }

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(
    Verifier2 _verifier2,
    uint32 _levels,
    address _hasher
  )
    MerkleTreeWithHistory(_levels, _hasher)
  {
    verifier2 = _verifier2;
    _disableInitializers();
  }

  function initialize(uint256 _maximumDepositAmount, address _admin) external initializer {
    require(_admin != address(0), "admin is zero address");
    _status = _NOT_ENTERED;
    admin = _admin;
    _configureLimits(_maximumDepositAmount);
    super._initialize();
  }

  function transact(Proof memory _args, ExtData memory _extData) public payable nonReentrant {
    require(isKnownRoot(_args.root), "Invalid merkle root");
    require(!isSpent(_args.inputNullifiers[0]) && !isSpent(_args.inputNullifiers[1]), "Input is already spent");
    require(uint256(_args.extDataHash) == uint256(keccak256(abi.encode(_extData))) % FIELD_SIZE, "Incorrect external data hash");
    require(_args.publicAmount == calculatePublicAmount(_extData.extAmount, _extData.fee), "Invalid public amount");
    require(verifyProof(_args), "Invalid transaction proof");

    nullifierHashes[_args.inputNullifiers[0]] = true;
    nullifierHashes[_args.inputNullifiers[1]] = true;

    // internal transfers are not allowed. if _extData.extAmount == 0, it will fail at calculatePublicAmount() above.
    if (_extData.extAmount > 0) {
      require(msg.value == uint256(_extData.extAmount), "Incorrect ETH value");
      require(uint256(_extData.extAmount) <= maximumDepositAmount, "amount is larger than maximumDepositAmount");
    } else if (_extData.extAmount < 0) {
      require(msg.value == 0, "Cannot send ETH during withdrawal");
      require(_extData.recipient != address(0), "Can't withdraw to zero address");
      (bool success, ) = _extData.recipient.call{value: uint256(-_extData.extAmount)}("");
      require(success, "ETH transfer failed");
    }

    // fees and feeRecipient are intentionally not checked at protocol level, as a tip to the relayer
    if (_extData.fee > 0) {
      (bool success, ) = _extData.feeRecipient.call{value: _extData.fee}("");
      require(success, "Fee transfer failed");
    }

    _insert(_args.outputCommitments[0], _args.outputCommitments[1]);
    emit NewCommitment(_args.outputCommitments[0], nextIndex - 2, _extData.encryptedOutput1);
    emit NewCommitment(_args.outputCommitments[1], nextIndex - 1, _extData.encryptedOutput2);
    emit NewNullifier(_args.inputNullifiers[0]);
    emit NewNullifier(_args.inputNullifiers[1]);
  }

  function transferAdmin(address _newAdmin) public onlyAdmin {
    require(_newAdmin != address(0), "new admin is zero address");
    pendingAdmin = _newAdmin;
  }

  function claimAdmin() public {
    require(msg.sender == pendingAdmin, "not pending admin");
    emit AdminChanged(admin, pendingAdmin);
    admin = pendingAdmin;
    pendingAdmin = address(0);
  }

  function configureLimits(uint256 _maximumDepositAmount) public onlyAdmin {
    _configureLimits(_maximumDepositAmount);
  }

  function calculatePublicAmount(int256 _extAmount, uint256 _fee) public pure returns (uint256) {
    require(_fee < MAX_FEE, "Invalid fee");
    require(_extAmount > -MAX_EXT_AMOUNT && _extAmount < MAX_EXT_AMOUNT, "Invalid ext amount");
    require((_extAmount > 0 && uint256(_extAmount) > _fee) || (_extAmount < 0 && uint256(-_extAmount) > _fee), "ext amount must exceed fee for deposits");
    int256 publicAmount = _extAmount - int256(_fee);
    return (publicAmount >= 0) ? uint256(publicAmount) : FIELD_SIZE - uint256(-publicAmount);
  }

  function isSpent(bytes32 _nullifierHash) public view returns (bool) {
    return nullifierHashes[_nullifierHash];
  }

  function isSpentArray(bytes32[] calldata _nullifierHashes) external view returns (bool[] memory spent) {
    spent = new bool[](_nullifierHashes.length);
    for (uint256 i = 0; i < _nullifierHashes.length; i++) {
      spent[i] = nullifierHashes[_nullifierHashes[i]];
    }
  }

  function verifyProof(Proof memory _args) public view returns (bool) {
    return
      verifier2.verifyProof(
        _args.pA,
        _args.pB,
        _args.pC,
        [
          uint256(_args.root),
          _args.publicAmount,
          uint256(_args.extDataHash),
          uint256(_args.inputNullifiers[0]),
          uint256(_args.inputNullifiers[1]),
          uint256(_args.outputCommitments[0]),
          uint256(_args.outputCommitments[1])
        ]
      );
  }

  // Only accept ETH via transact() -- direct sends would be permanently locked
  receive() external payable {
    revert("Use transact() to deposit");
  }

  function _configureLimits(uint256 _maximumDepositAmount) internal {
    maximumDepositAmount = _maximumDepositAmount;
    emit LimitsConfigured(_maximumDepositAmount);
  }

  function _authorizeUpgrade(address) internal override onlyAdmin {}
}
