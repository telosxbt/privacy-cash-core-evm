/**
 * Deploy the HyperTrader v1 stack (sub-account buys) on HyperEVM:
 *
 *   - Privacy pools (mixer): USDC, BTC, ETH (ERCPool) + HYPE (EtherPool, native).
 *     Each allows shielded deposit/withdraw of its asset.
 *   - TradeAccount implementation : EIP-1167 template, one clone per trade.
 *   - HyperTrader                 : spend shielded USDC (the quote pool) -> isolated
 *                                   spot buy -> deliver(tradeId) / cancel(tradeId)
 *                                   to a fresh address (EVM ERC-20 or HyperCore acct).
 *
 * The pools need NO trader role; trade()/deliver()/cancel() are permissionless and
 * relayer-friendly (reimbursed via the in-token `fee`).
 *
 * PRODUCTION NOTE: `configureCore` expects a HyperCore gateway implementing
 * {IHyperCore} where each {TradeAccount}'s calls act on ITS OWN core account.
 * That gateway is an integration step; this script deploys the EVM-side stack and
 * prints the wiring call.
 *
 * Configure ERC-20 pools via env (a pool is deployed for each asset whose address
 * is set). USDC is required (it is the trader's quote pool).
 *
 *   USDC=0x.. USDC_DECIMALS=6  BTC=0x.. BTC_DECIMALS=8  ETH=0x.. ETH_DECIMALS=18
 */
const fs = require('fs')
const path = require('path')
const { ethers } = require('hardhat')
const { utils } = ethers

const MERKLE_TREE_HEIGHT = 26

const ADMIN = process.env.ADMIN // defaults to deployer if unset
const USDC_CORE_TOKEN = parseInt(process.env.USDC_CORE_TOKEN || '0', 10)
const DEADLINE_SECS = parseInt(process.env.DEADLINE_SECS || '300', 10)
// Production CoreWriter system contract; set '' (empty) to leave writes unwired.
const CORE_WRITER = process.env.CORE_WRITER || '0x3333333333333333333333333333333333333333'
const WIRE_CORE = process.env.WIRE_CORE === '1' // deploy HyperCoreView + configureCore

// ERC-20 privacy pools to deploy (skipped when the token address is unset).
const ERC_ASSETS = [
  { key: 'usdc', token: process.env.USDC, decimals: process.env.USDC_DECIMALS || '6', max: process.env.USDC_MAX || '1000000', min: process.env.USDC_MIN || '1' },
  { key: 'btc', token: process.env.BTC, decimals: process.env.BTC_DECIMALS || '8', max: process.env.BTC_MAX || '100', min: process.env.BTC_MIN || '0.0001' },
  { key: 'eth', token: process.env.ETH, decimals: process.env.ETH_DECIMALS || '18', max: process.env.ETH_MAX || '1000', min: process.env.ETH_MIN || '0.001' },
].filter((a) => a.token)

const HYPE_MAX = utils.parseEther(process.env.HYPE_MAX || '10000')
const HYPE_MIN = utils.parseEther(process.env.HYPE_MIN || '0.001')

async function deployPoolProxy(factory, implArgs, max, min, admin) {
  const impl = await factory.deploy(...implArgs)
  await impl.deployed()
  const initData = factory.interface.encodeFunctionData('initialize', [max, min, admin])
  const Proxy = await ethers.getContractFactory('ERC1967Proxy')
  const proxy = await Proxy.deploy(impl.address, initData)
  await proxy.deployed()
  return { proxy: factory.attach(proxy.address), impl }
}

async function main() {
  require('./compileHasher')
  const [deployer] = await ethers.getSigners()
  const admin = ADMIN || deployer.address
  const net = await ethers.provider.getNetwork()

  console.log(`Deployer: ${deployer.address}`)
  console.log(`Admin:    ${admin}`)
  console.log(`Network:  ${net.name} (${net.chainId})`)
  const usdcCfg = ERC_ASSETS.find((a) => a.key === 'usdc')
  if (!usdcCfg) throw new Error('Set USDC=<usdc erc-20 address> (required: it is the quote pool)')

  const verifier2 = await (await ethers.getContractFactory('Verifier2')).deploy()
  await verifier2.deployed()
  const hasher = await (await ethers.getContractFactory('Hasher')).deploy()
  await hasher.deployed()
  console.log(`Verifier2: ${verifier2.address}`)
  console.log(`Hasher:    ${hasher.address}`)

  const ERCPool = await ethers.getContractFactory('ERCPool')
  const EtherPool = await ethers.getContractFactory('EtherPool')

  // ERC-20 pools (USDC, BTC, ETH, ...).
  const pools = {}
  for (const a of ERC_ASSETS) {
    const decimals = parseInt(a.decimals, 10)
    const max = utils.parseUnits(a.max, decimals)
    const min = utils.parseUnits(a.min, decimals)
    const { proxy, impl } = await deployPoolProxy(
      ERCPool,
      [verifier2.address, MERKLE_TREE_HEIGHT, hasher.address, a.token.toLowerCase()],
      max,
      min,
      admin,
    )
    pools[a.key] = { pool: proxy.address, impl: impl.address, token: a.token.toLowerCase(), decimals }
    console.log(`${a.key.toUpperCase()} pool: ${proxy.address}`)
  }

  // Native HYPE pool.
  const { proxy: hypePool, impl: hypeImpl } = await deployPoolProxy(
    EtherPool,
    [verifier2.address, MERKLE_TREE_HEIGHT, hasher.address],
    HYPE_MAX,
    HYPE_MIN,
    admin,
  )
  pools.hype = { pool: hypePool.address, impl: hypeImpl.address, native: true }
  console.log(`HYPE pool: ${hypePool.address}`)

  // Trader (quote = USDC pool) + TradeAccount template.
  const tradeImpl = await (await ethers.getContractFactory('TradeAccount')).deploy()
  await tradeImpl.deployed()
  const trader = await (await ethers.getContractFactory('HyperTrader')).deploy(admin, pools.usdc.pool, tradeImpl.address)
  await trader.deployed()
  console.log(`TradeAccount impl: ${tradeImpl.address}`)
  console.log(`Trader:            ${trader.address}`)

  // Production read gateway (precompile-backed). Writes are issued raw from each
  // TradeAccount via CORE_WRITER.
  let coreView = null
  if (WIRE_CORE) {
    const view = await (await ethers.getContractFactory('HyperCoreView')).deploy()
    await view.deployed()
    coreView = view.address
    console.log(`HyperCoreView: ${coreView}`)
    console.log('  -> register each asset on the view: view.registerToken(coreToken, coreDecimals, szDecimals)')
    if (admin.toLowerCase() === deployer.address.toLowerCase()) {
      await (await trader.configureCore(coreView, CORE_WRITER, USDC_CORE_TOKEN, DEADLINE_SECS)).wait()
      console.log(`Wired core (view=${coreView}, coreWriter=${CORE_WRITER}).`)
    }
  } else {
    console.log('\n⚠️  Core not wired (set WIRE_CORE=1 to deploy HyperCoreView + configureCore).')
    console.log('   The admin must eventually call:')
    console.log(`  trader.configureCore(<HyperCoreView>, ${CORE_WRITER}, ${USDC_CORE_TOKEN}, ${DEADLINE_SECS})`)
  }

  const out = {
    network: net.name,
    chainId: net.chainId,
    admin,
    verifier2: verifier2.address,
    hasher: hasher.address,
    tradeAccountImpl: tradeImpl.address,
    trader: trader.address,
    coreView,
    coreWriter: CORE_WRITER,
    usdcCoreToken: USDC_CORE_TOKEN,
    merkleTreeHeight: MERKLE_TREE_HEIGHT,
    pools,
  }
  const dir = path.join(__dirname, '..', 'deployments')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `v1-${net.chainId}.json`)
  fs.writeFileSync(file, JSON.stringify(out, null, 2))
  console.log(`\nDeployment written to ${file}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
