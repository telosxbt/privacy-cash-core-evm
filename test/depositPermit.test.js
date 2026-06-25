const hre = require('hardhat')
const { ethers, waffle } = hre
const { loadFixture } = waffle
const { expect } = require('chai')
const { BigNumber } = ethers

const { MerkleTree } = require('fixed-merkle-tree')
const Utxo = require('../src/utxo')
const { toFixedHex, poseidonHash2, getExtDataHash, FIELD_SIZE } = require('../src/utils')
const { signIn } = require('../src/encryption')
const { prove } = require('../src/prover')

const H = 26
const Z = '2795675251356313514992617062594790716374808130983166135938897961178374655502'
const MAX = BigNumber.from(10).pow(30)
const MIN = 1

function tree() {
  return new MerkleTree(H, [], { hashFunction: poseidonHash2, zeroElement: Z })
}

async function depositProof({ tree, outputs, encryptionKey }) {
  const inputs = [new Utxo(), new Utxo()]
  while (outputs.length < 2) outputs.push(new Utxo())
  const extAmount = outputs.reduce((s, x) => s.add(x.amount), BigNumber.from(0))
  let n = tree._layers[0].length
  for (const o of outputs) o.index = n++
  const extData = {
    recipient: toFixedHex(0, 20),
    extAmount: toFixedHex(extAmount),
    feeRecipient: toFixedHex(0, 20),
    fee: toFixedHex(0),
    encryptedOutput1: outputs[0].encrypt(encryptionKey),
    encryptedOutput2: outputs[1].encrypt(encryptionKey),
  }
  const extDataHash = getExtDataHash(extData)
  const input = {
    root: toFixedHex(tree.root),
    inputNullifier: inputs.map((x) => x.getNullifier().toString()),
    outputCommitment: outputs.map((x) => x.getCommitment().toString()),
    publicAmount: extAmount.toString(),
    extDataHash: extDataHash.toString(),
    mintAddress: inputs[0].mintAddress.toString(),
    inAmount: inputs.map((x) => x.amount.toString()),
    inPrivateKey: inputs.map((x) => x.keypair.privkey.toString()),
    inBlinding: inputs.map((x) => x.blinding.toString()),
    inPathIndices: [0, 0],
    inPathElements: [new Array(H).fill(0), new Array(H).fill(0)],
    outAmount: outputs.map((x) => x.amount.toString()),
    outBlinding: outputs.map((x) => x.blinding.toString()),
    outPubkey: outputs.map((x) => x.keypair.pubkey.toString()),
  }
  const { pA, pB, pC } = await prove(input, './build/circuits/transaction2')
  const args = {
    pA,
    pB,
    pC,
    root: toFixedHex(input.root),
    inputNullifiers: inputs.map((x) => toFixedHex(x.getNullifier())),
    outputCommitments: outputs.map((x) => toFixedHex(x.getCommitment())),
    publicAmount: toFixedHex(input.publicAmount),
    extDataHash: toFixedHex(extDataHash),
  }
  return { args, extData, extAmount }
}

describe('ERCPool.depositWithPermit (gasless deposit)', function () {
  async function fixture() {
    require('../scripts/compileHasher')
    const [deployer, admin, alice, relayer] = await ethers.getSigners()
    const token = await (await ethers.getContractFactory('MockERC20Permit')).deploy()
    await token.deployed()
    const verifier2 = await (await ethers.getContractFactory('Verifier2')).deploy()
    const hasher = await (await ethers.getContractFactory('Hasher')).deploy()

    const Pool = await ethers.getContractFactory('ERCPool')
    const impl = await Pool.deploy(verifier2.address, H, hasher.address, token.address)
    await impl.deployed()
    const initData = Pool.interface.encodeFunctionData('initialize', [MAX, MIN, admin.address])
    const proxy = await (await ethers.getContractFactory('ERC1967Proxy')).deploy(impl.address, initData)
    await proxy.deployed()
    const pool = Pool.attach(proxy.address)

    await token.mint(alice.address, 1_000_000)
    const { encryptionKey, keypair } = await signIn(alice)
    return { token, pool, admin, alice, relayer, encryptionKey, keypair }
  }

  async function signPermit(token, owner, spender, value, deadline) {
    const net = await ethers.provider.getNetwork()
    const domain = { name: 'MockPermit', version: '1', chainId: net.chainId, verifyingContract: token.address }
    const types = {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    }
    const nonce = await token.nonces(owner.address)
    const sig = await owner._signTypedData(domain, types, { owner: owner.address, spender, value, nonce, deadline })
    return ethers.utils.splitSignature(sig)
  }

  async function signAuth(signer, pool, c0, c1, extAmount, deadline) {
    const net = await ethers.provider.getNetwork()
    const inner = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ['string', 'uint256', 'address', 'bytes32', 'bytes32', 'int256', 'uint256'],
        ['PrivacyCashDeposit', net.chainId, pool.address, c0, c1, extAmount, deadline],
      ),
    )
    const sig = await signer.signMessage(ethers.utils.arrayify(inner))
    return ethers.utils.splitSignature(sig)
  }

  it('relayer deposits with the user paying no gas; tokens pulled from the user', async function () {
    const { token, pool, alice, relayer, encryptionKey, keypair } = await loadFixture(fixture)
    const t = tree()
    const AMOUNT = BigNumber.from(5000)
    const note = new Utxo({ amount: AMOUNT, keypair })
    const { args, extData, extAmount } = await depositProof({ tree: t, outputs: [note], encryptionKey })
    const deadline = (await ethers.provider.getBlock('latest')).timestamp + 3600

    const ps = await signPermit(token, alice, pool.address, AMOUNT, deadline)
    const as_ = await signAuth(alice, pool, args.outputCommitments[0], args.outputCommitments[1], extAmount, deadline)

    const aliceBefore = await token.balanceOf(alice.address)
    // relayer (not alice) sends the tx
    await pool.connect(relayer).depositWithPermit(args, extData, {
      owner: alice.address,
      value: AMOUNT,
      deadline,
      permitV: ps.v, permitR: ps.r, permitS: ps.s,
      authV: as_.v, authR: as_.r, authS: as_.s,
    })

    expect(await token.balanceOf(pool.address)).to.equal(AMOUNT)
    expect(await token.balanceOf(alice.address)).to.equal(aliceBefore.sub(AMOUNT))
  })

  it('SECURITY: a relayer cannot pair the permit with a different note', async function () {
    const { token, pool, alice, relayer, encryptionKey, keypair } = await loadFixture(fixture)
    const t = tree()
    const AMOUNT = BigNumber.from(5000)
    const note = new Utxo({ amount: AMOUNT, keypair })
    const { args, extData, extAmount } = await depositProof({ tree: t, outputs: [note], encryptionKey })
    const deadline = (await ethers.provider.getBlock('latest')).timestamp + 3600
    const ps = await signPermit(token, alice, pool.address, AMOUNT, deadline)

    // alice authorized note `args.outputCommitments`, but the relayer signs an auth
    // for a DIFFERENT commitment (or tampers) — recover != alice -> revert.
    const wrongAuth = await signAuth(relayer, pool, args.outputCommitments[0], args.outputCommitments[1], extAmount, deadline)
    await expect(
      pool.connect(relayer).depositWithPermit(args, extData, {
        owner: alice.address,
        value: AMOUNT,
        deadline,
        permitV: ps.v, permitR: ps.r, permitS: ps.s,
        authV: wrongAuth.v, authR: wrongAuth.r, authS: wrongAuth.s,
      }),
    ).to.be.revertedWith('bad deposit auth')
  })
})
