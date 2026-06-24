/**
 * Deploy the HyperTrader v1 stack (buy-only, fire-and-forget) on HyperEVM:
 *
 *   - USDC privacy pool (ERCPool)        : shielded deposit/withdraw of USDC
 *   - HYPE privacy pool (EtherPool)      : shielded deposit/withdraw of native HYPE
 *   - HyperCoreAdapter                   : EVM <-> HyperCore bridge + spot buys
 *   - HyperTrader                        : spend shielded USDC -> spot buy -> send
 *                                          the bought asset to a fresh address
 *
 * The pools need NO trader role: the controller only ever uses the standard
 * withdrawal path. Deposits/withdrawals (and trades) are submitted by a relayer
 * that pays gas in HYPE and is reimbursed via the in-token `fee` field.
 *
 * Configure via env vars (see DEFAULTS below). Register the buyable assets
 * (BTC/ETH/HYPE/...) on the adapter via ASSETS (JSON array).
 *
 *   ASSETS='[{"evmToken":"0x..","coreToken":1242,"evmDecimals":18,"coreDecimals":9,"szDecimals":4}]'
 */
const fs = require('fs')
const path = require('path')
const { ethers } = require('hardhat')
const { utils } = ethers

const MERKLE_TREE_HEIGHT = 26
const CORE_WRITER = process.env.CORE_WRITER || '0x3333333333333333333333333333333333333333'

const ADMIN = process.env.ADMIN // defaults to deployer if unset
const USDC = (process.env.USDC || '').toLowerCase()
const USDC_DECIMALS = parseInt(process.env.USDC_DECIMALS || '6', 10)
const USDC_CORE_TOKEN = parseInt(process.env.USDC_CORE_TOKEN || '0', 10)
const USDC_CORE_DECIMALS = parseInt(process.env.USDC_CORE_DECIMALS || '8', 10)
const USDC_SZ_DECIMALS = parseInt(process.env.USDC_SZ_DECIMALS || '0', 10)
const DEADLINE_SECS = parseInt(process.env.DEADLINE_SECS || '300', 10)

const USDC_MAX = utils.parseUnits(process.env.USDC_MAX || '1000000', USDC_DECIMALS)
const USDC_MIN = utils.parseUnits(process.env.USDC_MIN || '1', USDC_DECIMALS)
const HYPE_MAX = utils.parseEther(process.env.HYPE_MAX || '10000')
const HYPE_MIN = utils.parseEther(process.env.HYPE_MIN || '0.001')

async function deployProxy(factory, implArgs, initArgs) {
  const impl = await factory.deploy(...implArgs)
  await impl.deployed()
  const initData = factory.interface.encodeFunctionData('initialize', initArgs)
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
  if (!USDC) throw new Error('Set USDC=<usdc erc-20 address>')

  const verifier2 = await (await ethers.getContractFactory('Verifier2')).deploy()
  await verifier2.deployed()
  const hasher = await (await ethers.getContractFactory('Hasher')).deploy()
  await hasher.deployed()
  console.log(`Verifier2: ${verifier2.address}`)
  console.log(`Hasher:    ${hasher.address}`)

  // USDC pool (ERC-20) + HYPE pool (native).
  const ERCPool = await ethers.getContractFactory('ERCPool')
  const { proxy: usdcPool, impl: usdcImpl } = await deployProxy(
    ERCPool,
    [verifier2.address, MERKLE_TREE_HEIGHT, hasher.address, USDC],
    [USDC_MAX, USDC_MIN, admin],
  )
  const EtherPool = await ethers.getContractFactory('EtherPool')
  const { proxy: hypePool, impl: hypeImpl } = await deployProxy(
    EtherPool,
    [verifier2.address, MERKLE_TREE_HEIGHT, hasher.address],
    [HYPE_MAX, HYPE_MIN, admin],
  )
  console.log(`USDC pool: ${usdcPool.address}`)
  console.log(`HYPE pool: ${hypePool.address}`)

  // Trader (quote = USDC pool) then adapter (owner = trader).
  const trader = await (await ethers.getContractFactory('HyperTrader')).deploy(admin, usdcPool.address)
  await trader.deployed()
  const adapter = await (await ethers.getContractFactory('HyperCoreAdapter')).deploy(CORE_WRITER, trader.address)
  await adapter.deployed()
  console.log(`Trader:    ${trader.address}`)
  console.log(`Adapter:   ${adapter.address}`)

  // Register USDC + the buyable assets on the adapter (deployer is adapter admin).
  await (await adapter.registerToken(USDC, USDC_CORE_TOKEN, USDC_DECIMALS, USDC_CORE_DECIMALS, USDC_SZ_DECIMALS)).wait()
  const assets = JSON.parse(process.env.ASSETS || '[]')
  for (const a of assets) {
    await (await adapter.registerToken(a.evmToken, a.coreToken, a.evmDecimals, a.coreDecimals, a.szDecimals)).wait()
    console.log(`  registered asset coreToken=${a.coreToken} (${a.evmToken})`)
  }

  // Wire the adapter into the trader (admin-gated).
  if (admin.toLowerCase() === deployer.address.toLowerCase()) {
    await (await trader.configureAdapter(adapter.address, USDC_CORE_TOKEN, DEADLINE_SECS)).wait()
    console.log('Wiring complete (trader.configureAdapter).')
  } else {
    console.log('\n⚠️  Admin != deployer. Have the admin call:')
    console.log(`  trader.configureAdapter(${adapter.address}, ${USDC_CORE_TOKEN}, ${DEADLINE_SECS})`)
  }

  const out = {
    network: net.name,
    chainId: net.chainId,
    admin,
    verifier2: verifier2.address,
    hasher: hasher.address,
    adapter: adapter.address,
    trader: trader.address,
    coreWriter: CORE_WRITER,
    merkleTreeHeight: MERKLE_TREE_HEIGHT,
    pools: {
      usdc: { pool: usdcPool.address, impl: usdcImpl.address, token: USDC, decimals: USDC_DECIMALS, coreToken: USDC_CORE_TOKEN },
      hype: { pool: hypePool.address, impl: hypeImpl.address, native: true },
    },
    assets,
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
