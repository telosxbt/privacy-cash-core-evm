// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockERC20Permit
 * @notice ERC-20 with a hand-rolled EIP-2612 `permit` (manual EIP-712 domain to
 *         avoid OZ's EIP712, which pulls in Cancun-only opcodes). Used to test
 *         {ERCPool.depositWithPermit}.
 */
contract MockERC20Permit is ERC20 {
  mapping(address => uint256) public nonces;
  bytes32 public immutable DOMAIN_SEPARATOR;

  bytes32 private constant PERMIT_TYPEHASH =
    keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

  constructor() ERC20("MockPermit", "MUSDC") {
    _mint(msg.sender, type(uint256).max / 4);
    DOMAIN_SEPARATOR = keccak256(
      abi.encode(
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
        keccak256(bytes("MockPermit")),
        keccak256(bytes("1")),
        block.chainid,
        address(this)
      )
    );
  }

  function mint(address to, uint256 amount) external {
    _mint(to, amount);
  }

  function permit(
    address owner,
    address spender,
    uint256 value,
    uint256 deadline,
    uint8 v,
    bytes32 r,
    bytes32 s
  ) external {
    require(block.timestamp <= deadline, "permit expired");
    bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonces[owner]++, deadline));
    bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    address signer = ecrecover(digest, v, r, s);
    require(signer != address(0) && signer == owner, "bad permit");
    _approve(owner, spender, value);
  }
}
