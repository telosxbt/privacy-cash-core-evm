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

const VENUE_EVM = 0
const VENUE_CORE = 1

const POOL_MIN = 1
const POOL_MAX = BigNumber.from(10).pow(30)
const FRESH = '0x000000000000000000000000000000000000bEEF'

function createEmptyTree() {
  return new MerkleTree(MERKLE_TREE_HEIGHT, [], { hashFunction: poseidonHash2, zeroElement: MERKLE_TREE_ZERO_VALUE })
}

async function getProof({ inputs, outputs, tree, extAmount, fee, recipient, feeRecipient, encryptionKey }) {
  const ii = []
  const ie = []
  for (const i of inputs) {
    if (i.amount.gt(0)) {
      i.index = tree.indexOf(toFixedHex(i.getCommitment()))
      if (i.index < 0) throw new Error('input not found')
      ii.push(i.index)
      ie.push(tree.path(i.index).pathElements)
    } else {
      ii.push(0)
      ie.push(new Array(MERKLE_TREE_HEIGHT).fill(0))
    }
  }
  let n = tree._layers[0].length
  for (const o of outputs) o.index = n++
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
    inPathIndices: ii,
    inPathElements: ie,
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
    .add(outputs.reduce((s, x) => s.add(x.amount), BigNumber.from(0)))
    .sub(inputs.reduce((s, x) => s.add(x.amount), BigNumber.from(0)))
  return getProof({ inputs, outputs, tree, extAmount, fee, recipient, feeRecipient, encryptionKey })
}

async function deploy(name, ...args) {
  const f = await ethers.getContractFactory(name)
  const i = await f.deploy(...args)
  return i.deployed()
}

async function poolTransact({ pool, token, tree, signer, ...rest }) {
  const { args, extData, outputs } = await prepareTransaction({ tree, ...rest })
  const extAmount = BigNumber.from(extData.extAmount)
  const s = signer || (await ethers.getSigners())[0]
  if (extAmount.gt(0)) await token.connect(s).approve(pool.address, extAmount)
  await (await pool.connect(s).transact(args, extData, { gasLimit: 3_000_000 })).wait()
  for (const o of outputs) tree.insert(toFixedHex(o.getCommitment()))
  return { args, extData, outputs }
}

describe('HyperTrader v1 (sub-account buys, EVM/Core delivery)', function () {
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
    const tradeImpl = await deploy('TradeAccount')
    const trader = await deploy('HyperTrader', admin.address, usdcPool.address, tradeImpl.address)

    await trader.connect(admin).configureCore(mock.address, USDC_CORE, 3600)
    await mock.register(USDC_CORE, usdc.address)
    await mock.register(ASSET_CORE, asset.address)
    await mock.setMarket(ASSET_SPOT, ASSET_CORE, USDC_CORE, PX)

    await usdc.mint(alice.address, USDC_IN.mul(10))
    await asset.mint(mock.address, SIZE * 10) // HyperCore asset inventory for EVM delivery

    const { encryptionKey, keypair } = await signIn(alice)
    return { usdc, asset, usdcPool, trader, mock, admin, alice, keeper, encryptionKey, keypair }
  }

  function tradeParams({ size = SIZE, limitPx = PX, cloid = 1, recipient = FRESH, venue = VENUE_EVM, deadline = 0 }) {
    return { asset: ASSET_SPOT, assetCoreToken: ASSET_CORE, size, limitPx, cloid, recipient, venue, deadline }
  }

  // Deposit `deposit` USDC (shielded) and return a withdrawal proof to the controller.
  async function spend({ usdcPool, usdc, tree, keypair, encryptionKey, trader, deposit, withdraw, fee = 0, feeRecipient = 0 }) {
    const [deployer] = await ethers.getSigners()
    const dep = new Utxo({ amount: deposit, keypair })
    await usdc.mint(deployer.address, deposit)
    await poolTransact({ pool: usdcPool, token: usdc, tree, outputs: [dep], encryptionKey })
    const change = BigNumber.from(deposit).sub(withdraw).sub(fee)
    const outputs = change.gt(0) ? [new Utxo({ amount: change, keypair })] : []
    return prepareTransaction({ tree, inputs: [dep], outputs, recipient: trader.address, fee, feeRecipient, encryptionKey })
  }

  it('happy path EVM: shielded USDC -> buy -> deliver asset as ERC-20 on HyperEVM', async function () {
    const { usdc, asset, usdcPool, trader, keeper, encryptionKey, keypair } = await loadFixture(fixture)
    const tree = createEmptyTree()
    const { args, extData } = await spend({ usdcPool, usdc, tree, keypair, encryptionKey, trader, deposit: USDC_IN, withdraw: USDC_IN })

    await expect(trader.connect(keeper).trade(args, extData, tradeParams({ venue: VENUE_EVM }))).to.emit(trader, 'Traded')
    expect(await usdc.balanceOf(usdcPool.address)).to.equal(0)

    await expect(trader.connect(keeper).deliver(0)).to.emit(trader, 'Delivered')
    expect(await asset.balanceOf(FRESH)).to.equal(SIZE)
  })

  it('happy path CORE: deliver the asset to a HyperCore spot account', async function () {
    const { usdc, asset, usdcPool, trader, mock, keeper, encryptionKey, keypair } = await loadFixture(fixture)
    const tree = createEmptyTree()
    const { args, extData } = await spend({ usdcPool, usdc, tree, keypair, encryptionKey, trader, deposit: USDC_IN, withdraw: USDC_IN })

    await trader.connect(keeper).trade(args, extData, tradeParams({ venue: VENUE_CORE, cloid: 2 }))
    await trader.connect(keeper).deliver(0)

    // stays on HyperCore: credited to the recipient's core account, not bridged to EVM
    expect(await mock.coreBalance(FRESH, ASSET_CORE)).to.equal(SIZE)
    expect(await asset.balanceOf(FRESH)).to.equal(0)
  })

  it('per-trade isolation: an unfilled trade cannot deliver against another trade fill', async function () {
    const { usdc, asset, usdcPool, trader, mock, keeper, encryptionKey, keypair } = await loadFixture(fixture)
    const tree = createEmptyTree()
    const rA = ethers.utils.getAddress('0x000000000000000000000000000000000000aaaa')
    const rB = ethers.utils.getAddress('0x000000000000000000000000000000000000bbbb')

    // Trade A fills (limit == market); mirror the withdrawal leaves after each trade.
    const a = await spend({ usdcPool, usdc, tree, keypair, encryptionKey, trader, deposit: USDC_IN, withdraw: USDC_IN })
    await trader.connect(keeper).trade(a.args, a.extData, tradeParams({ limitPx: PX, cloid: 11, recipient: rA }))
    for (const o of a.outputs) tree.insert(toFixedHex(o.getCommitment()))

    // Trade B does NOT fill (limit below market).
    const b = await spend({ usdcPool, usdc, tree, keypair, encryptionKey, trader, deposit: USDC_IN, withdraw: USDC_IN })
    await trader.connect(keeper).trade(b.args, b.extData, tradeParams({ limitPx: PX - 1, cloid: 12, recipient: rB }))
    for (const o of b.outputs) tree.insert(toFixedHex(o.getCommitment()))

    // A's asset sits on A's own account; B's account is empty -> B cannot deliver.
    await expect(trader.connect(keeper).deliver(1)).to.be.revertedWith('not filled')

    // A delivers fine against its own fill.
    await trader.connect(keeper).deliver(0)
    expect(await asset.balanceOf(rA)).to.equal(SIZE)
    expect(await asset.balanceOf(rB)).to.equal(0)
  })

  it('deliver reverts before the order has filled', async function () {
    const { usdc, usdcPool, trader, keeper, encryptionKey, keypair } = await loadFixture(fixture)
    const tree = createEmptyTree()
    const { args, extData } = await spend({ usdcPool, usdc, tree, keypair, encryptionKey, trader, deposit: USDC_IN, withdraw: USDC_IN })
    await trader.connect(keeper).trade(args, extData, tradeParams({ limitPx: PX - 1, cloid: 3 })) // unfillable
    await expect(trader.connect(keeper).deliver(0)).to.be.revertedWith('not filled')
  })

  it('relayer model: relayer paid a USDC fee out of the note; user sends no tx', async function () {
    const { usdc, asset, usdcPool, trader, keeper, encryptionKey, keypair } = await loadFixture(fixture)
    const tree = createEmptyTree()
    const [, , , relayer] = await ethers.getSigners()
    const FEE = BigNumber.from(50)

    const { args, extData } = await spend({
      usdcPool, usdc, tree, keypair, encryptionKey, trader,
      deposit: USDC_IN.add(FEE), withdraw: USDC_IN, fee: FEE, feeRecipient: relayer.address,
    })
    await trader.connect(relayer).trade(args, extData, tradeParams({ cloid: 4 }))
    await trader.connect(relayer).deliver(0)

    expect(await usdc.balanceOf(relayer.address)).to.equal(FEE)
    expect(await asset.balanceOf(FRESH)).to.equal(SIZE)
  })

  it('cancel: an expired, unfilled trade refunds the USDC to the recipient', async function () {
    const { usdc, usdcPool, trader, keeper, encryptionKey, keypair } = await loadFixture(fixture)
    const tree = createEmptyTree()
    const { args, extData } = await spend({ usdcPool, usdc, tree, keypair, encryptionKey, trader, deposit: USDC_IN, withdraw: USDC_IN })

    // unfillable order + deadline already in the past
    await trader.connect(keeper).trade(args, extData, tradeParams({ limitPx: PX - 1, cloid: 5, deadline: 1 }))
    await expect(trader.connect(keeper).cancel(0)).to.emit(trader, 'Cancelled')

    // the USDC the user wanted to spend is refunded to their chosen recipient
    expect(await usdc.balanceOf(FRESH)).to.equal(USDC_IN)
    const t = await trader.trades(0)
    expect(t.status).to.equal(3) // Cancelled
  })

  it('cancel: reverts before the deadline', async function () {
    const { usdc, usdcPool, trader, keeper, encryptionKey, keypair } = await loadFixture(fixture)
    const tree = createEmptyTree()
    const { args, extData } = await spend({ usdcPool, usdc, tree, keypair, encryptionKey, trader, deposit: USDC_IN, withdraw: USDC_IN })
    // default deadline (now + 3600), not yet passed
    await trader.connect(keeper).trade(args, extData, tradeParams({ limitPx: PX - 1, cloid: 6 }))
    await expect(trader.connect(keeper).cancel(0)).to.be.revertedWith('before deadline')
  })

  it('access control: only admin configures core', async function () {
    const { trader, alice, mock } = await loadFixture(fixture)
    await expect(trader.connect(alice).configureCore(mock.address, USDC_CORE, 3600)).to.be.revertedWith('only admin')
  })
})
