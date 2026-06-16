/**
 * Deploy the full Hypercash system (privacy-preserving HyperCore spot trading):
 *
 *   Verifier2 + Hasher  ->  USDC pool + BTC pool (UUPS proxies)
 *                       ->  HyperTrader controller
 *                       ->  HyperCoreAdapter (or a mock on local networks)
 *
 * and wire all the roles + market config in one shot. Writes the resulting
 * addresses to `deployments/<network>.json` (consumed by the frontend).
 *
 * Everything is env-driven so the same script works on a fork, testnet, or
 * HyperEVM mainnet. See the CONFIG block below for the knobs; sane defaults are
 * provided for a local/mock run so `npx hardhat run scripts/deployHypercash.js`
 * works out of the box.
 *
 * Usage:
 *   npx hardhat run scripts/deployHypercash.js --network hyperevm
 *   (set the *_ADDRESS / *_CORE_* env vars first — see .env.example)
 */
const fs = require('fs')
const path = require('path')
const { ethers, network } = require('hardhat')
const { utils } = ethers

const MERKLE_TREE_HEIGHT = 26
// HyperCore CoreWriter system contract on HyperEVM.
const CORE_WRITER = '0x3333333333333333333333333333333333333333'

function envInt(name, fallback) {
  return process.env[name] !== undefined ? parseInt(process.env[name], 10) : fallback
}

// Deploy a UUPS pool behind an ERC1967 proxy (impl + proxy), mirroring the
// proven path used in the test fixture rather than the upgrades plugin (which
// can't see the initializer inherited from ERCPool).
async function deployPool({ token, verifier2, hasher, admin, maxDeposit, minAmount }) {
  const Pool = await ethers.getContractFactory('HyperPrivacyPool')
  const impl = await Pool.deploy(verifier2, MERKLE_TREE_HEIGHT, hasher, token)
  await impl.deployed()
  const initData = Pool.interface.encodeFunctionData('initialize', [maxDeposit, minAmount, admin])
  const Proxy = await ethers.getContractFactory('ERC1967Proxy')
  const proxy = await Proxy.deploy(impl.address, initData)
  await proxy.deployed()
  return Pool.attach(proxy.address)
}

async function main() {
  require('./compileHasher')

  const [deployer] = await ethers.getSigners()
  const net = await ethers.provider.getNetwork()
  const isLocal = ['hardhat', 'localhost'].includes(network.name)

  // ----------------------------------------------------------------- CONFIG
  const ADMIN = process.env.ADMIN_ADDRESS || deployer.address

  // Asset config. On a local run we deploy MockERC20s so the script is runnable
  // end-to-end; on a real network you MUST pass the real token addresses.
  const USDC_DECIMALS = envInt('USDC_DECIMALS', 6)
  const BTC_DECIMALS = envInt('BTC_DECIMALS', 8)
  const CORE_DECIMALS = envInt('CORE_DECIMALS', 8) // HyperCore wei decimals

  // HyperCore linkage ids (spot token ids + the BTC/USDC spot pair index).
  const USDC_CORE_TOKEN = envInt('USDC_CORE_TOKEN', 1)
  const BTC_CORE_TOKEN = envInt('BTC_CORE_TOKEN', 2)
  const BTC_SPOT_ASSET = envInt('BTC_SPOT_ASSET', 10)

  // Minimum BTC trade size (dust floor), in core units, and order deadline.
  const MIN_BTC_SIZE = envInt('MIN_BTC_SIZE', 1)
  const DEADLINE_SECS = envInt('DEADLINE_SECS', 3600)

  // Per-pool deposit bounds (in token units).
  const USDC_MAX = utils.parseUnits(process.env.USDC_MAX || '1000000', USDC_DECIMALS)
  const USDC_MIN = utils.parseUnits(process.env.USDC_MIN || '1', USDC_DECIMALS)
  const BTC_MAX = utils.parseUnits(process.env.BTC_MAX || '1000', BTC_DECIMALS)
  const BTC_MIN = utils.parseUnits(process.env.BTC_MIN || '0.0001', BTC_DECIMALS)

  console.log(`\n=== Hypercash deploy on ${network.name} (chainId ${net.chainId}) ===`)
  console.log(`Deployer: ${deployer.address}`)
  console.log(`Admin:    ${ADMIN}`)

  // --------------------------------------------------------------- tokens
  let usdcAddress = process.env.USDC_ADDRESS
  let btcAddress = process.env.BTC_ADDRESS
  if (isLocal && (!usdcAddress || !btcAddress)) {
    console.log('\nLocal network without token addresses -> deploying MockERC20s')
    const Mock = await ethers.getContractFactory('MockERC20')
    const usdc = await Mock.deploy()
    await usdc.deployed()
    const btc = await Mock.deploy()
    await btc.deployed()
    usdcAddress = usdc.address
    btcAddress = btc.address
  }
  if (!usdcAddress || !btcAddress) {
    throw new Error('Set USDC_ADDRESS and BTC_ADDRESS env vars for a non-local deploy')
  }

  // --------------------------------------------------------------- core libs
  const Verifier2 = await ethers.getContractFactory('Verifier2')
  const verifier2 = await Verifier2.deploy()
  await verifier2.deployed()
  console.log(`\nVerifier2:  ${verifier2.address}`)

  const Hasher = await ethers.getContractFactory('Hasher')
  const hasher = await Hasher.deploy()
  await hasher.deployed()
  console.log(`Hasher:     ${hasher.address}`)

  // --------------------------------------------------------------- pools
  const usdcPool = await deployPool({
    token: usdcAddress,
    verifier2: verifier2.address,
    hasher: hasher.address,
    admin: ADMIN,
    maxDeposit: USDC_MAX,
    minAmount: USDC_MIN,
  })
  console.log(`USDC pool:  ${usdcPool.address}`)

  const btcPool = await deployPool({
    token: btcAddress,
    verifier2: verifier2.address,
    hasher: hasher.address,
    admin: ADMIN,
    maxDeposit: BTC_MAX,
    minAmount: BTC_MIN,
  })
  console.log(`BTC pool:   ${btcPool.address}`)

  // --------------------------------------------------------------- controller
  const Trader = await ethers.getContractFactory('HyperTrader')
  const trader = await Trader.deploy(ADMIN, usdcPool.address, btcPool.address)
  await trader.deployed()
  console.log(`HyperTrader:${trader.address}`)

  // --------------------------------------------------------------- adapter
  // On local networks use the deterministic mock; on HyperEVM use the real one.
  let adapterAddress
  let coreAccount = process.env.CORE_ACCOUNT
  if (isLocal) {
    const Mock = await ethers.getContractFactory('MockHyperCore')
    const mock = await Mock.deploy()
    await mock.deployed()
    adapterAddress = mock.address
    coreAccount = coreAccount || mock.address
    await (await mock.register(USDC_CORE_TOKEN, usdcAddress)).wait()
    await (await mock.register(BTC_CORE_TOKEN, btcAddress)).wait()
    await (await mock.setMarket(BTC_SPOT_ASSET, BTC_CORE_TOKEN, USDC_CORE_TOKEN, envInt('MOCK_PX', 5))).wait()
    console.log(`Adapter(mock):${adapterAddress}`)
  } else {
    const Adapter = await ethers.getContractFactory('HyperCoreAdapter')
    const adapter = await Adapter.deploy(CORE_WRITER, trader.address) // deployer becomes config admin
    await adapter.deployed()
    adapterAddress = adapter.address
    coreAccount = coreAccount || adapter.address
    await (await adapter.registerToken(usdcAddress, USDC_CORE_TOKEN, USDC_DECIMALS, CORE_DECIMALS)).wait()
    await (await adapter.registerToken(btcAddress, BTC_CORE_TOKEN, BTC_DECIMALS, CORE_DECIMALS)).wait()
    console.log(`Adapter:    ${adapterAddress}`)
  }

  // --------------------------------------------------------------- wiring
  // configureTrader / configureAdapter / configureMarket are admin-gated. If the
  // admin is the deployer we can wire here; otherwise we print the calls to make.
  if (ADMIN.toLowerCase() === deployer.address.toLowerCase()) {
    await (await usdcPool.configureTrader(trader.address)).wait()
    await (await btcPool.configureTrader(trader.address)).wait()
    await (await trader.configureAdapter(adapterAddress, coreAccount)).wait()
    await (
      await trader.configureMarket(USDC_CORE_TOKEN, BTC_CORE_TOKEN, BTC_SPOT_ASSET, MIN_BTC_SIZE, DEADLINE_SECS)
    ).wait()
    console.log('\nWiring complete (configureTrader / configureAdapter / configureMarket).')
  } else {
    console.log('\n⚠️  Admin != deployer. Have the admin call:')
    console.log(`  usdcPool.configureTrader(${trader.address})`)
    console.log(`  btcPool.configureTrader(${trader.address})`)
    console.log(`  trader.configureAdapter(${adapterAddress}, ${coreAccount})`)
    console.log(
      `  trader.configureMarket(${USDC_CORE_TOKEN}, ${BTC_CORE_TOKEN}, ${BTC_SPOT_ASSET}, ${MIN_BTC_SIZE}, ${DEADLINE_SECS})`,
    )
  }

  // --------------------------------------------------------------- output
  const out = {
    network: network.name,
    chainId: net.chainId,
    admin: ADMIN,
    verifier2: verifier2.address,
    hasher: hasher.address,
    adapter: adapterAddress,
    coreAccount,
    trader: trader.address,
    merkleTreeHeight: MERKLE_TREE_HEIGHT,
    pools: {
      usdc: { pool: usdcPool.address, token: usdcAddress, decimals: USDC_DECIMALS, coreToken: USDC_CORE_TOKEN },
      btc: {
        pool: btcPool.address,
        token: btcAddress,
        decimals: BTC_DECIMALS,
        coreToken: BTC_CORE_TOKEN,
        spotAsset: BTC_SPOT_ASSET,
      },
    },
    market: { minBtcSize: MIN_BTC_SIZE, deadlineSecs: DEADLINE_SECS, coreDecimals: CORE_DECIMALS },
  }
  const dir = path.join(__dirname, '..', 'deployments')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${network.name}.json`)
  fs.writeFileSync(file, JSON.stringify(out, null, 2))
  console.log(`\nDeployment written to ${file}`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
