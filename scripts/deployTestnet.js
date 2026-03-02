const { ethers, upgrades } = require('hardhat')
const { utils } = ethers

const MERKLE_TREE_HEIGHT = 26
const MAXIMUM_DEPOSIT_AMOUNT = utils.parseEther('10')
const ADMIN_ADDRESS = process.env.ADMIN_ADDRESS || '0x44eb9939cfdE7C394f1632C6890191d695f0a3ce'

async function main() {
  require('./compileHasher')

  const [deployer] = await ethers.getSigners()
  console.log(`Deploying contracts with account: ${deployer.address}`)
  console.log(`Account balance: ${utils.formatEther(await deployer.getBalance())} ETH`)

  const Verifier2 = await ethers.getContractFactory('Verifier2')
  const verifier2 = await Verifier2.deploy()
  await verifier2.deployed()
  console.log(`Verifier2 deployed at: ${verifier2.address}`)

  const Hasher = await ethers.getContractFactory('Hasher')
  const hasher = await Hasher.deploy()
  await hasher.deployed()
  console.log(`Hasher deployed at: ${hasher.address}`)

  const EtherPool = await ethers.getContractFactory('EtherPool')
  const etherPool = await upgrades.deployProxy(
    EtherPool,
    [MAXIMUM_DEPOSIT_AMOUNT, ADMIN_ADDRESS],
    {
      kind: 'uups',
      initializer: 'initialize',
      constructorArgs: [verifier2.address, MERKLE_TREE_HEIGHT, hasher.address],
      unsafeAllow: ['state-variable-immutable', 'constructor'],
    },
  )
  await etherPool.deployed()
  console.log(`EtherPool proxy deployed at: ${etherPool.address}`)
  console.log(`EtherPool initialized with MAXIMUM_DEPOSIT_AMOUNT=${utils.formatEther(MAXIMUM_DEPOSIT_AMOUNT)} ETH`)

  let implAddress = 'unknown'
  try {
    implAddress = await upgrades.erc1967.getImplementationAddress(etherPool.address)
  } catch {
    // On live networks the ERC-1967 slot may not be readable immediately after deployment
  }
  const network = await ethers.provider.getNetwork()
  console.log('\n--- Deployment Summary ---')
  console.log(`Network:    ${network.name} (chainId: ${network.chainId})`)
  console.log(`Verifier2:  ${verifier2.address}`)
  console.log(`Hasher:     ${hasher.address}`)
  console.log(`EtherPool (proxy):  ${etherPool.address}`)
  console.log(`EtherPool (impl):   ${implAddress}`)
  console.log(`Admin:      ${ADMIN_ADDRESS}`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
