/**
 * Deploy the HyperTrader v1 stack (sub-account buys) on HyperEVM:
 *
 *   - USDC privacy pool (ERCPool)   : shielded deposit/withdraw of USDC
 *   - HYPE privacy pool (EtherPool) : shielded deposit/withdraw of native HYPE
 *   - TradeAccount implementation   : EIP-1167 template, one clone per trade
 *   - HyperTrader                   : spend shielded USDC -> isolated spot buy
 *                                     -> deliver(tradeId) to a fresh address
 *                                        (EVM ERC-20 or HyperCore account)
 *
 * The pools need NO trader role (the controller only uses the standard withdrawal
 * path). trade()/deliver() are permissionless; a relayer submits both and is
 * reimbursed via the in-token `fee` field.
 *
 * PRODUCTION NOTE: `configureCore` expects a HyperCore gateway implementing
 * {IHyperCore} where each {TradeAccount}'s calls act on ITS OWN core account
 * (raw CoreWriter actions issued from the TradeAccount). That production gateway
 * is an integration step; this script deploys the EVM-side stack and prints the
 * call to wire it once available.
 */
const fs = require('fs')
const path = require('path')
const { ethers } = require('hardhat')
const { utils } = ethers

const MERKLE_TREE_HEIGHT = 26

const ADMIN = process.env.ADMIN // defaults to deployer if unset
const USDC = (process.env.USDC || '').toLowerCase()
const USDC_DECIMALS = parseInt(process.env.USDC_DECIMALS || '6', 10)
const USDC_CORE_TOKEN = parseInt(process.env.USDC_CORE_TOKEN || '0', 10)
const DEADLINE_SECS = parseInt(process.env.DEADLINE_SECS || '300', 10)
const CORE_GATEWAY = process.env.CORE_GATEWAY // IHyperCore impl; optional at deploy time

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

  const tradeImpl = await (await ethers.getContractFactory('TradeAccount')).deploy()
  await tradeImpl.deployed()
  const trader = await (await ethers.getContractFactory('HyperTrader')).deploy(admin, usdcPool.address, tradeImpl.address)
  await trader.deployed()
  console.log(`TradeAccount impl: ${tradeImpl.address}`)
  console.log(`Trader:            ${trader.address}`)

  if (CORE_GATEWAY && admin.toLowerCase() === deployer.address.toLowerCase()) {
    await (await trader.configureCore(CORE_GATEWAY, USDC_CORE_TOKEN, DEADLINE_SECS)).wait()
    console.log(`Wired core gateway ${CORE_GATEWAY}.`)
  } else {
    console.log('\n⚠️  configureCore not set. Once the HyperCore gateway is deployed, the admin must call:')
    console.log(`  trader.configureCore(<IHyperCore gateway>, ${USDC_CORE_TOKEN}, ${DEADLINE_SECS})`)
  }

  const out = {
    network: net.name,
    chainId: net.chainId,
    admin,
    verifier2: verifier2.address,
    hasher: hasher.address,
    tradeAccountImpl: tradeImpl.address,
    trader: trader.address,
    coreGateway: CORE_GATEWAY || null,
    usdcCoreToken: USDC_CORE_TOKEN,
    merkleTreeHeight: MERKLE_TREE_HEIGHT,
    pools: {
      usdc: { pool: usdcPool.address, impl: usdcImpl.address, token: USDC, decimals: USDC_DECIMALS },
      hype: { pool: hypePool.address, impl: hypeImpl.address, native: true },
    },
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
