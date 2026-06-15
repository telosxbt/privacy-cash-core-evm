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
const BTC_CORE = 2
const BTC_ASSET = 10
const BTC_DENOM = 100 // fixed BTC note size (core units)
const MARKET_PX = 5 // USDC core per BTC core

// fixed-size USDC trade note
const TRADE_USDC = BigNumber.from(BTC_DENOM * MARKET_PX) // 500
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
      if (input.index < 0) {
        throw new Error(`Input commitment ${toFixedHex(input.getCommitment())} was not found`)
      }
      inputMerklePathIndices.push(input.index)
      inputMerklePathElements.push(tree.path(input.index).pathElements)
    } else {
      inputMerklePathIndices.push(0)
      inputMerklePathElements.push(new Array(MERKLE_TREE_HEIGHT).fill(0))
    }
  }

  let nextIndex = tree._layers[0].length
  for (const output of outputs) {
    output.index = nextIndex++
  }

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

// Standard shielded transact directly against a pool (deposit or withdraw).
async function poolTransact({ pool, token, tree, signer, ...rest }) {
  const { args, extData, outputs } = await prepareTransaction({ tree, ...rest })
  const extAmount = BigNumber.from(extData.extAmount)
  const s = signer || (await ethers.getSigners())[0]
  if (extAmount.gt(0)) {
    await token.connect(s).approve(pool.address, extAmount)
  }
  await (await pool.connect(s).transact(args, extData, { gasLimit: 3_000_000 })).wait()
  for (const o of outputs) tree.insert(toFixedHex(o.getCommitment()))
  return { args, extData, outputs }
}

describe('HyperTrader (privacy-preserving HyperCore spot trading)', function () {
  async function fixture() {
    require('../scripts/compileHasher')
    const [deployer, admin, alice, keeper] = await ethers.getSigners()

    const usdc = await deploy('MockERC20')
    const btc = await deploy('MockERC20')
    const verifier2 = await deploy('Verifier2')
    const hasher = await deploy('Hasher')

    async function deployPool(token) {
      const Pool = await ethers.getContractFactory('HyperPrivacyPool')
      const impl = await Pool.deploy(verifier2.address, MERKLE_TREE_HEIGHT, hasher.address, token.address)
      await impl.deployed()
      const initData = Pool.interface.encodeFunctionData('initialize', [POOL_MAX, POOL_MIN, admin.address])
      const Proxy = await ethers.getContractFactory('ERC1967Proxy')
      const proxy = await Proxy.deploy(impl.address, initData)
      await proxy.deployed()
      return Pool.attach(proxy.address)
    }

    const usdcPool = await deployPool(usdc)
    const btcPool = await deployPool(btc)

    const mock = await deploy('MockHyperCore')
    const trader = await deploy('HyperTrader', admin.address, usdcPool.address, btcPool.address)

    // wire everything
    await usdcPool.connect(admin).configureTrader(trader.address)
    await btcPool.connect(admin).configureTrader(trader.address)
    await trader.connect(admin).configureAdapter(mock.address, mock.address)
    await trader.connect(admin).configureMarket(USDC_CORE, BTC_CORE, BTC_ASSET, BTC_DENOM, 3600)

    await mock.register(USDC_CORE, usdc.address)
    await mock.register(BTC_CORE, btc.address)
    await mock.setMarket(BTC_ASSET, BTC_CORE, USDC_CORE, MARKET_PX)

    // fund: alice has USDC to deposit; the mock holds BTC inventory (HyperCore liquidity)
    await usdc.mint(alice.address, TRADE_USDC.mul(10))
    await btc.mint(mock.address, BTC_DENOM * 10)

    const { encryptionKey, keypair } = await signIn(alice)

    return { usdc, btc, usdcPool, btcPool, trader, mock, admin, alice, keeper, encryptionKey, keypair, verifier2, hasher }
  }

  // Builds the BTC settlement notes + the trade params for one anonymous trade.
  function buildTradeNotes({ keypair, encryptionKey }) {
    const btcNote = new Utxo({ amount: BTC_DENOM, keypair })
    const btcChange = new Utxo({ amount: 0, keypair })
    const refundNote = new Utxo({ amount: TRADE_USDC, keypair })
    return { btcNote, btcChange, refundNote }
  }

  async function depositAndProveWithdraw({ usdcPool, usdc, tree, keypair, encryptionKey, trader }) {
    const [deployer] = await ethers.getSigners()
    // 1. shielded USDC deposit (fixed size), funded by the deployer signer
    const depositUtxo = new Utxo({ amount: TRADE_USDC, keypair })
    await usdc.mint(deployer.address, TRADE_USDC)
    await poolTransact({ pool: usdcPool, token: usdc, tree, outputs: [depositUtxo], encryptionKey })

    // 2. withdrawal proof spending the deposit, recipient = controller
    const { args, extData } = await prepareTransaction({
      tree,
      inputs: [depositUtxo],
      outputs: [],
      recipient: trader.address,
      encryptionKey,
    })
    return { args, extData, depositUtxo }
  }

  it('happy path: deposit USDC -> shielded spot BTC buy -> private BTC claim', async function () {
    const { usdc, btc, usdcPool, btcPool, trader, mock, alice, keeper, encryptionKey, keypair } = await loadFixture(fixture)
    const usdcTree = createEmptyTree()
    const btcTree = createEmptyTree()

    const { btcNote, btcChange } = buildTradeNotes({ keypair, encryptionKey })
    const { args, extData } = await depositAndProveWithdraw({ usdcPool, usdc, tree: usdcTree, alice, keypair, encryptionKey, trader })

    expect(await usdc.balanceOf(usdcPool.address)).to.equal(TRADE_USDC)

    // initiate the anonymous trade
    const params = {
      limitPx: MARKET_PX, // exactly at market => fills
      deadline: 0,
      cloid: 1,
      btcCommitment: toFixedHex(btcNote.getCommitment()),
      btcCommitment2: toFixedHex(btcChange.getCommitment()),
      refundCommitment: ethers.constants.HashZero,
      encryptedOutput1: btcNote.encrypt(encryptionKey),
      encryptedOutput2: btcChange.encrypt(encryptionKey),
    }
    await expect(trader.connect(keeper).initiateTrade(args, extData, params)).to.emit(trader, 'TradeInitiated')

    // USDC left the pool toward HyperCore; BTC credited on core
    expect(await usdc.balanceOf(usdcPool.address)).to.equal(0)
    expect(await mock.coreBalance(BTC_CORE)).to.equal(BTC_DENOM)

    // settle: bridge BTC back into the BTC pool and mint the BTC note
    await expect(trader.connect(keeper).settleTrade(0)).to.emit(trader, 'TradeSettled')
    expect(await btc.balanceOf(btcPool.address)).to.equal(BTC_DENOM)

    // off-chain: mirror the BTC tree insert order
    btcTree.insert(toFixedHex(btcNote.getCommitment()))
    btcTree.insert(toFixedHex(btcChange.getCommitment()))

    // 5. private claim: Alice withdraws her BTC note to a fresh address, unlinkable to the USDC deposit
    const aliceBtcRecipient = '0x000000000000000000000000000000000000bEEF'
    await poolTransact({
      pool: btcPool,
      token: btc,
      tree: btcTree,
      inputs: [btcNote],
      outputs: [],
      recipient: aliceBtcRecipient,
      encryptionKey,
    })

    expect(await btc.balanceOf(aliceBtcRecipient)).to.equal(BTC_DENOM)
    expect(await btc.balanceOf(btcPool.address)).to.equal(0)
  })

  it('slippage protection: order does not fill above limit, then retry succeeds', async function () {
    const { usdc, btc, usdcPool, btcPool, trader, mock, alice, keeper, encryptionKey, keypair } = await loadFixture(fixture)
    const usdcTree = createEmptyTree()
    const btcTree = createEmptyTree()
    const { btcNote, btcChange } = buildTradeNotes({ keypair, encryptionKey })
    const { args, extData } = await depositAndProveWithdraw({ usdcPool, usdc, tree: usdcTree, alice, keypair, encryptionKey, trader })

    const params = {
      limitPx: MARKET_PX - 1, // below market => no fill
      deadline: 0,
      cloid: 7,
      btcCommitment: toFixedHex(btcNote.getCommitment()),
      btcCommitment2: toFixedHex(btcChange.getCommitment()),
      refundCommitment: ethers.constants.HashZero,
      encryptedOutput1: btcNote.encrypt(encryptionKey),
      encryptedOutput2: btcChange.encrypt(encryptionKey),
    }
    await trader.connect(keeper).initiateTrade(args, extData, params)

    // nothing filled, USDC parked on core
    expect(await mock.coreBalance(BTC_CORE)).to.equal(0)
    expect(await mock.coreBalance(USDC_CORE)).to.equal(TRADE_USDC)
    await expect(trader.connect(keeper).settleTrade(0)).to.be.revertedWith('not filled')

    // retry at a higher limit -> fills
    await trader.connect(keeper).retryTrade(0, MARKET_PX, 0, 8)
    expect(await mock.coreBalance(BTC_CORE)).to.equal(BTC_DENOM)

    await trader.connect(keeper).settleTrade(0)
    btcTree.insert(toFixedHex(btcNote.getCommitment()))
    btcTree.insert(toFixedHex(btcChange.getCommitment()))
    expect(await btc.balanceOf(btcPool.address)).to.equal(BTC_DENOM)
  })

  it('cancel path: unfilled trade past deadline refunds USDC as a shielded note', async function () {
    const { usdc, usdcPool, trader, mock, alice, keeper, encryptionKey, keypair } = await loadFixture(fixture)
    const usdcTree = createEmptyTree()
    const { btcNote, btcChange, refundNote } = buildTradeNotes({ keypair, encryptionKey })
    const { args, extData } = await depositAndProveWithdraw({ usdcPool, usdc, tree: usdcTree, alice, keypair, encryptionKey, trader })

    const params = {
      limitPx: MARKET_PX - 1, // no fill
      deadline: 1, // already in the past
      cloid: 11,
      btcCommitment: toFixedHex(btcNote.getCommitment()),
      btcCommitment2: toFixedHex(btcChange.getCommitment()),
      refundCommitment: toFixedHex(refundNote.getCommitment()),
      encryptedOutput1: btcNote.encrypt(encryptionKey),
      encryptedOutput2: btcChange.encrypt(encryptionKey),
    }
    await trader.connect(keeper).initiateTrade(args, extData, params)
    expect(await usdc.balanceOf(usdcPool.address)).to.equal(0)

    await expect(trader.connect(keeper).cancelTrade(0)).to.emit(trader, 'TradeCancelled')

    // USDC bridged back and re-shielded into the pool
    expect(await usdc.balanceOf(usdcPool.address)).to.equal(TRADE_USDC)
    const trade = await trader.trades(0)
    expect(trade.status).to.equal(3) // Cancelled
  })

  it('access control: only the controller can mint settlement notes', async function () {
    const { btcPool, alice } = await loadFixture(fixture)
    await expect(
      btcPool.connect(alice).traderMint(ethers.constants.HashZero, ethers.constants.HashZero, '0x', '0x'),
    ).to.be.revertedWith('only trader')
  })

  it('access control: only admin configures the controller', async function () {
    const { trader, alice, mock } = await loadFixture(fixture)
    await expect(trader.connect(alice).configureAdapter(mock.address, mock.address)).to.be.revertedWith('only admin')
    await expect(
      trader.connect(alice).configureMarket(USDC_CORE, BTC_CORE, BTC_ASSET, BTC_DENOM, 3600),
    ).to.be.revertedWith('only admin')
  })

  it('rejects initiate when recipient is not the controller', async function () {
    const { usdc, usdcPool, trader, alice, keeper, encryptionKey, keypair } = await loadFixture(fixture)
    const usdcTree = createEmptyTree()
    const { btcNote, btcChange } = buildTradeNotes({ keypair, encryptionKey })

    // deposit then build a withdrawal whose recipient is a random EOA (not the controller)
    const depositUtxo = new Utxo({ amount: TRADE_USDC, keypair })
    await usdc.mint((await ethers.getSigners())[0].address, TRADE_USDC)
    await poolTransact({ pool: usdcPool, token: usdc, tree: usdcTree, outputs: [depositUtxo], encryptionKey })
    const { args, extData } = await prepareTransaction({
      tree: usdcTree,
      inputs: [depositUtxo],
      outputs: [],
      recipient: alice.address,
      encryptionKey,
    })
    const params = {
      limitPx: MARKET_PX,
      deadline: 0,
      cloid: 99,
      btcCommitment: toFixedHex(btcNote.getCommitment()),
      btcCommitment2: toFixedHex(btcChange.getCommitment()),
      refundCommitment: ethers.constants.HashZero,
      encryptedOutput1: '0x',
      encryptedOutput2: '0x',
    }
    await expect(trader.connect(keeper).initiateTrade(args, extData, params)).to.be.revertedWith(
      'recipient must be controller',
    )
  })
})
