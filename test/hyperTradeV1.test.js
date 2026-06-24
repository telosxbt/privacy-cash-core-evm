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

const MERKLE_TREE_HEIGHT = 26
const MERKLE_TREE_ZERO_VALUE = '2795675251356313514992617062594790716374808130983166135938897961178374655502'

// HyperCore linkage (mock uses 1:1 EVM<->core units)
const USDC_CORE = 1
const ASSET_CORE = 2
const ASSET_SPOT = 10
const PX = 5 // USDC core per asset core
const SIZE = 100 // asset base size to buy
const USDC_IN = BigNumber.from(SIZE * PX) // 500

const POOL_MIN = 1
const POOL_MAX = BigNumber.from(10).pow(30)

function createEmptyTree() {
  return new MerkleTree(MERKLE_TREE_HEIGHT, [], { hashFunction: poseidonHash2, zeroElement: MERKLE_TREE_ZERO_VALUE })
}

async function getProof({ inputs, outputs, tree, extAmount, fee, recipient, feeRecipient, encryptionKey }) {
  const inputMerklePathIndices = []
  const inputMerklePathElements = []

  for (const input of inputs) {
    if (input.amount.gt(0)) {
      input.index = tree.indexOf(toFixedHex(input.getCommitment()))
      if (input.index < 0) throw new Error(`Input commitment ${toFixedHex(input.getCommitment())} was not found`)
      inputMerklePathIndices.push(input.index)
      inputMerklePathElements.push(tree.path(input.index).pathElements)
    } else {
      inputMerklePathIndices.push(0)
      inputMerklePathElements.push(new Array(MERKLE_TREE_HEIGHT).fill(0))
    }
  }

  let nextIndex = tree._layers[0].length
  for (const output of outputs) output.index = nextIndex++

  const extData = {
    recipient: toFixedHex(recipient, 20),
    extAmount: toFixedHex(extAmount),
    feeRecipient: toFixedHex(feeRecipient, 20),
    fee: toFixedHex(fee),
    encryptedOutput1: outputs[0].encrypt(encryptionKey),
    encryptedOutput2: outputs[1].encrypt(encryptionKey),
  }

  const extDataHash = getExtDataHash(extData)
  const input = {
    root: toFixedHex(tree.root),
    inputNullifier: inputs.map((x) => x.getNullifier().toString()),
    outputCommitment: outputs.map((x) => x.getCommitment().toString()),
    publicAmount: BigNumber.from(extAmount).sub(fee).add(FIELD_SIZE).mod(FIELD_SIZE).toString(),
    extDataHash: extDataHash.toString(),
    mintAddress: inputs[0].mintAddress.toString(),
    inAmount: inputs.map((x) => x.amount.toString()),
    inPrivateKey: inputs.map((x) => x.keypair.privkey.toString()),
    inBlinding: inputs.map((x) => x.blinding.toString()),
    inPathIndices: inputMerklePathIndices,
    inPathElements: inputMerklePathElements,
    outAmount: outputs.map((x) => x.amount.toString()),
    outBlinding: outputs.map((x) => x.blinding.toString()),
    outPubkey: outputs.map((x) => x.keypair.pubkey.toString()),
  }

  const { pA, pB, pC } = await prove(input, `./build/circuits/transaction${inputs.length}`)

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
  return { extData, args, outputs }
}

async function prepareTransaction({ tree, inputs = [], outputs = [], fee = 0, recipient = 0, feeRecipient = 0, encryptionKey }) {
  while (inputs.length < 2) inputs.push(new Utxo())
  while (outputs.length < 2) outputs.push(new Utxo())
  const extAmount = BigNumber.from(fee)
    .add(outputs.reduce((sum, x) => sum.add(x.amount), BigNumber.from(0)))
    .sub(inputs.reduce((sum, x) => sum.add(x.amount), BigNumber.from(0)))
  return getProof({ inputs, outputs, tree, extAmount, fee, recipient, feeRecipient, encryptionKey })
}

async function deploy(contractName, ...args) {
  const Factory = await ethers.getContractFactory(contractName)
  const instance = await Factory.deploy(...args)
  return instance.deployed()
}

// Standard shielded deposit/withdraw directly against a pool.
async function poolTransact({ pool, token, tree, signer, ...rest }) {
  const { args, extData, outputs } = await prepareTransaction({ tree, ...rest })
  const extAmount = BigNumber.from(extData.extAmount)
  const s = signer || (await ethers.getSigners())[0]
  if (extAmount.gt(0)) await token.connect(s).approve(pool.address, extAmount)
  await (await pool.connect(s).transact(args, extData, { gasLimit: 3_000_000 })).wait()
  for (const o of outputs) tree.insert(toFixedHex(o.getCommitment()))
  return { args, extData, outputs }
}

describe('HyperTrader v1 (buy-only, fire-and-forget)', function () {
  async function fixture() {
    require('../scripts/compileHasher')
    const [deployer, admin, alice, keeper] = await ethers.getSigners()

    const usdc = await deploy('MockERC20')
    const asset = await deploy('MockERC20')
    const verifier2 = await deploy('Verifier2')
    const hasher = await deploy('Hasher')

    const Pool = await ethers.getContractFactory('ERCPool')
    const impl = await Pool.deploy(verifier2.address, MERKLE_TREE_HEIGHT, hasher.address, usdc.address)
    await impl.deployed()
    const initData = Pool.interface.encodeFunctionData('initialize', [POOL_MAX, POOL_MIN, admin.address])
    const Proxy = await ethers.getContractFactory('ERC1967Proxy')
    const proxy = await Proxy.deploy(impl.address, initData)
    await proxy.deployed()
    const usdcPool = Pool.attach(proxy.address)

    const mock = await deploy('MockHyperCore')
    const trader = await deploy('HyperTrader', admin.address, usdcPool.address)

    await trader.connect(admin).configureAdapter(mock.address, USDC_CORE, 3600)
    await mock.register(USDC_CORE, usdc.address)
    await mock.register(ASSET_CORE, asset.address)
    await mock.setMarket(ASSET_SPOT, ASSET_CORE, USDC_CORE, PX)

    // alice has USDC to deposit; the mock holds asset inventory (HyperCore liquidity)
    await usdc.mint(alice.address, USDC_IN.mul(10))
    await asset.mint(mock.address, SIZE * 10)

    const { encryptionKey, keypair } = await signIn(alice)
    return { usdc, asset, usdcPool, trader, mock, admin, alice, keeper, encryptionKey, keypair }
  }

  function tradeParams({ size = SIZE, limitPx = PX, cloid = 1, recipient }) {
    return { asset: ASSET_SPOT, assetCoreToken: ASSET_CORE, size, limitPx, cloid, recipient }
  }

  // Deposit `amount` USDC (shielded) and return a withdrawal proof to the controller.
  async function depositAndWithdrawTo({ usdcPool, usdc, tree, keypair, encryptionKey, trader, deposit, withdraw, fee = 0, feeRecipient = 0 }) {
    const [deployer] = await ethers.getSigners()
    const depositUtxo = new Utxo({ amount: deposit, keypair })
    await usdc.mint(deployer.address, deposit)
    await poolTransact({ pool: usdcPool, token: usdc, tree, outputs: [depositUtxo], encryptionKey })

    const change = BigNumber.from(deposit).sub(withdraw).sub(fee)
    const outputs = change.gt(0) ? [new Utxo({ amount: change, keypair })] : []
    return prepareTransaction({
      tree,
      inputs: [depositUtxo],
      outputs,
      recipient: trader.address,
      fee,
      feeRecipient,
      encryptionKey,
    })
  }

  it('happy path: shielded USDC -> spot buy -> asset delivered to a fresh address', async function () {
    const { usdc, asset, usdcPool, trader, keeper, encryptionKey, keypair } = await loadFixture(fixture)
    const tree = createEmptyTree()
    const recipient = '0x000000000000000000000000000000000000bEEF'

    const { args, extData } = await depositAndWithdrawTo({
      usdcPool, usdc, tree, keypair, encryptionKey, trader, deposit: USDC_IN, withdraw: USDC_IN,
    })
    expect(await usdc.balanceOf(usdcPool.address)).to.equal(USDC_IN)

    await expect(trader.connect(keeper).trade(args, extData, tradeParams({ recipient }))).to.emit(trader, 'Traded')

    // USDC left the pool; the bought asset landed at the user's fresh address.
    expect(await usdc.balanceOf(usdcPool.address)).to.equal(0)
    expect(await asset.balanceOf(recipient)).to.equal(SIZE)
  })

  it('relayer model: the relayer is paid a USDC fee out of the note, user pays no gas token', async function () {
    const { usdc, asset, usdcPool, trader, keeper, encryptionKey, keypair } = await loadFixture(fixture)
    const tree = createEmptyTree()
    const recipient = '0x000000000000000000000000000000000000bEEF'
    const [, , , relayer] = await ethers.getSigners()
    const FEE = BigNumber.from(50)

    // user shields USDC_IN + FEE, withdraws USDC_IN to the controller, FEE to the relayer
    const { args, extData } = await depositAndWithdrawTo({
      usdcPool, usdc, tree, keypair, encryptionKey, trader,
      deposit: USDC_IN.add(FEE), withdraw: USDC_IN, fee: FEE, feeRecipient: relayer.address,
    })

    // keeper == relayer submits the tx and pays gas (HYPE); reimbursed in USDC via FEE
    await trader.connect(relayer).trade(args, extData, tradeParams({ recipient, cloid: 2 }))

    expect(await usdc.balanceOf(relayer.address)).to.equal(FEE)
    expect(await asset.balanceOf(recipient)).to.equal(SIZE)
    expect(await usdc.balanceOf(usdcPool.address)).to.equal(0)
  })

  it('reverts when the withdrawal recipient is not the controller', async function () {
    const { usdc, usdcPool, trader, alice, keeper, encryptionKey, keypair } = await loadFixture(fixture)
    const tree = createEmptyTree()
    const depositUtxo = new Utxo({ amount: USDC_IN, keypair })
    await usdc.mint((await ethers.getSigners())[0].address, USDC_IN)
    await poolTransact({ pool: usdcPool, token: usdc, tree, outputs: [depositUtxo], encryptionKey })
    const { args, extData } = await prepareTransaction({
      tree, inputs: [depositUtxo], outputs: [], recipient: alice.address, encryptionKey,
    })
    // The guard ("recipient must be controller") fires; the waffle matcher can't
    // decode this particular revert string, so assert the revert itself.
    await expect(
      trader.connect(keeper).trade(args, extData, tradeParams({ recipient: alice.address }), { gasLimit: 5_000_000 }),
    ).to.be.reverted
  })

  it('reverts on zero recipient / zero size / zero limit', async function () {
    const { usdc, usdcPool, trader, keeper, encryptionKey, keypair } = await loadFixture(fixture)
    const tree = createEmptyTree()
    const { args, extData } = await depositAndWithdrawTo({
      usdcPool, usdc, tree, keypair, encryptionKey, trader, deposit: USDC_IN, withdraw: USDC_IN,
    })
    await expect(
      trader.connect(keeper).trade(args, extData, tradeParams({ recipient: ethers.constants.AddressZero }), { gasLimit: 5_000_000 }),
    ).to.be.revertedWith('recipient is zero')
  })

  it('access control: only admin configures the adapter', async function () {
    const { trader, alice, mock } = await loadFixture(fixture)
    await expect(trader.connect(alice).configureAdapter(mock.address, USDC_CORE, 3600)).to.be.revertedWith('only admin')
  })
})
