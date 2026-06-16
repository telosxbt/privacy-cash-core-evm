/**
 * Deploy a new tradable asset market on top of an existing Hypercash deployment.
 *
 * One market = a new {HyperPrivacyPool} for the asset + a dedicated {HyperTrader}
 * controller bound to (shared USDC pool, new asset pool). The asset token is
 * linked on the adapter, the controller is authorised on BOTH pools, and the
 * market is configured. Because the USDC pool authorises a *set* of controllers,
 * every market you add keeps drawing on the same USDC anonymity set.
 *
 * Reads the base deployment from `deployments/<network>.json` (produced by
 * deployHypercash.js) and appends the new market under `markets[ASSET_SYMBOL]`.
 *
 * Required env:
 *   ASSET_SYMBOL        e.g. ETH
 *   ASSET_ADDRESS       ERC-20 on HyperEVM (omit on local -> a MockERC20 is deployed)
 *   ASSET_CORE_TOKEN    HyperCore spot token id
 *   ASSET_SPOT_ASSET    HyperCore spot pair index (USDC-quoted)
 * Optional env:
 *   ASSET_DECIMALS (18) ASSET_CORE_DECIMALS (8) MIN_SIZE (1) DEADLINE_SECS (3600)
 *   ASSET_MAX (1000)    ASSET_MIN (0.0001)
 *
 * Usage:
 *   ASSET_SYMBOL=ETH ASSET_ADDRESS=0x.. ASSET_CORE_TOKEN=3 ASSET_SPOT_ASSET=11 \
 *     npx hardhat run scripts/deployPool.js --network hyperevm
 */
const fs = require('fs')
const path = require('path')
const { ethers, network } = require('hardhat')
const { utils } = ethers

const MERKLE_TREE_HEIGHT = 26

function envInt(name, fallback) {
  return process.env[name] !== undefined ? parseInt(process.env[name], 10) : fallback
}
function reqEnv(name) {
  if (!process.env[name]) throw new Error(`Missing required env var ${name}`)
  return process.env[name]
}

async function main() {
  require('./compileHasher')
  const [deployer] = await ethers.getSigners()
  const net = await ethers.provider.getNetwork()
  const isLocal = ['hardhat', 'localhost'].includes(network.name)

  const file = path.join(__dirname, '..', 'deployments', `${network.name}.json`)
  if (!fs.existsSync(file)) {
    throw new Error(`No base deployment at ${file}. Run deployHypercash.js first.`)
  }
  const dep = JSON.parse(fs.readFileSync(file, 'utf8'))

  const SYMBOL = reqEnv('ASSET_SYMBOL').toLowerCase()
  const ASSET_DECIMALS = envInt('ASSET_DECIMALS', 18)
  const ASSET_CORE_DECIMALS = envInt('ASSET_CORE_DECIMALS', dep.market.coreDecimals || 8)
  const ASSET_CORE_TOKEN = envInt('ASSET_CORE_TOKEN', undefined)
  const ASSET_SPOT_ASSET = envInt('ASSET_SPOT_ASSET', undefined)
  const MIN_SIZE = envInt('MIN_SIZE', 1)
  const DEADLINE_SECS = envInt('DEADLINE_SECS', dep.market.deadlineSecs || 3600)
  if (ASSET_CORE_TOKEN === undefined || ASSET_SPOT_ASSET === undefined) {
    throw new Error('Set ASSET_CORE_TOKEN and ASSET_SPOT_ASSET')
  }

  const ASSET_MAX = utils.parseUnits(process.env.ASSET_MAX || '1000', ASSET_DECIMALS)
  const ASSET_MIN = utils.parseUnits(process.env.ASSET_MIN || '0.0001', ASSET_DECIMALS)

  console.log(`\n=== Add ${SYMBOL.toUpperCase()} market on ${network.name} ===`)

  // -------------------------------------------------------------- asset token
  let assetAddress = process.env.ASSET_ADDRESS
  if (isLocal && !assetAddress) {
    const Mock = await ethers.getContractFactory('MockERC20')
    const m = await Mock.deploy()
    await m.deployed()
    assetAddress = m.address
    console.log(`MockERC20 (${SYMBOL}): ${assetAddress}`)
  }
  if (!assetAddress) throw new Error('Set ASSET_ADDRESS for a non-local deploy')

  // -------------------------------------------------------------- asset pool
  const Pool = await ethers.getContractFactory('HyperPrivacyPool')
  const impl = await Pool.deploy(dep.verifier2, MERKLE_TREE_HEIGHT, dep.hasher, assetAddress)
  await impl.deployed()
  const initData = Pool.interface.encodeFunctionData('initialize', [ASSET_MAX, ASSET_MIN, dep.admin])
  const Proxy = await ethers.getContractFactory('ERC1967Proxy')
  const proxy = await Proxy.deploy(impl.address, initData)
  await proxy.deployed()
  const assetPool = Pool.attach(proxy.address)
  console.log(`${SYMBOL} pool:  ${assetPool.address}`)

  // -------------------------------------------------------------- controller
  const Trader = await ethers.getContractFactory('HyperTrader')
  const trader = await Trader.deploy(dep.admin, dep.pools.usdc.pool, assetPool.address)
  await trader.deployed()
  console.log(`HyperTrader: ${trader.address}`)

  // -------------------------------------------------------------- adapter link
  // Linking the token is config-only (admin role on the adapter). On a mock the
  // register call is open; on the real adapter the deployer is the config admin.
  const adapter = await ethers.getContractAt(isLocal ? 'MockHyperCore' : 'HyperCoreAdapter', dep.adapter)
  if (isLocal) {
    await (await adapter.register(ASSET_CORE_TOKEN, assetAddress)).wait()
    await (await adapter.setMarket(ASSET_SPOT_ASSET, ASSET_CORE_TOKEN, dep.pools.usdc.coreToken, envInt('MOCK_PX', 5))).wait()
  } else {
    await (await adapter.registerToken(assetAddress, ASSET_CORE_TOKEN, ASSET_DECIMALS, ASSET_CORE_DECIMALS)).wait()
  }

  // -------------------------------------------------------------- wiring
  const usdcPool = await ethers.getContractAt('HyperPrivacyPool', dep.pools.usdc.pool)
  if (dep.admin.toLowerCase() === deployer.address.toLowerCase()) {
    await (await usdcPool.configureTrader(trader.address)).wait() // additive: shared USDC pool
    await (await assetPool.configureTrader(trader.address)).wait()
    await (await trader.configureAdapter(dep.adapter, dep.coreAccount)).wait()
    await (
      await trader.configureMarket(dep.pools.usdc.coreToken, ASSET_CORE_TOKEN, ASSET_SPOT_ASSET, MIN_SIZE, DEADLINE_SECS)
    ).wait()
    console.log('Wiring complete.')
  } else {
    console.log('\n⚠️  Admin != deployer. Have the admin call:')
    console.log(`  usdcPool(${dep.pools.usdc.pool}).configureTrader(${trader.address})`)
    console.log(`  assetPool(${assetPool.address}).configureTrader(${trader.address})`)
    console.log(`  trader.configureAdapter(${dep.adapter}, ${dep.coreAccount})`)
    console.log(
      `  trader.configureMarket(${dep.pools.usdc.coreToken}, ${ASSET_CORE_TOKEN}, ${ASSET_SPOT_ASSET}, ${MIN_SIZE}, ${DEADLINE_SECS})`,
    )
  }

  // -------------------------------------------------------------- persist
  dep.markets = dep.markets || {}
  dep.markets[SYMBOL] = {
    pool: assetPool.address,
    token: assetAddress,
    decimals: ASSET_DECIMALS,
    coreToken: ASSET_CORE_TOKEN,
    spotAsset: ASSET_SPOT_ASSET,
    trader: trader.address,
    minSize: MIN_SIZE,
  }
  fs.writeFileSync(file, JSON.stringify(dep, null, 2))
  console.log(`\nUpdated ${file} (markets.${SYMBOL})`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
