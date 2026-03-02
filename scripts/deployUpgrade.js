const { ethers, upgrades } = require('hardhat')

async function main() {
  const proxyAddress = process.env.PROXY_ADDRESS
  if (!proxyAddress) {
    throw new Error('PROXY_ADDRESS env variable is required')
  }

  const [deployer] = await ethers.getSigners()
  console.log(`Upgrading with account: ${deployer.address}`)

  const proxy = await ethers.getContractAt('EtherPool', proxyAddress)
  const currentAdmin = await proxy.admin()
  console.log(`Current admin: ${currentAdmin}`)

  const verifier2Address = await proxy.verifier2()
  const levels = await proxy.levels()
  const hasherAddress = await proxy.hasher()

  console.log(`Using existing immutables: verifier2=${verifier2Address}, levels=${levels}, hasher=${hasherAddress}`)

  const EtherPoolV2 = await ethers.getContractFactory('EtherPool')

  if (deployer.address.toLowerCase() === currentAdmin.toLowerCase()) {
    // Direct upgrade: deployer is the admin
    const upgraded = await upgrades.upgradeProxy(proxyAddress, EtherPoolV2, {
      kind: 'uups',
      constructorArgs: [verifier2Address, levels, hasherAddress],
      unsafeAllow: ['state-variable-immutable', 'constructor'],
    })
    console.log(`EtherPool upgraded at proxy: ${upgraded.address}`)
  } else {
    // Deployer is not the admin — deploy & validate the new implementation only.
    // The admin (e.g. multisig) must call upgradeTo() separately.
    const newImpl = await upgrades.prepareUpgrade(proxyAddress, EtherPoolV2, {
      kind: 'uups',
      constructorArgs: [verifier2Address, levels, hasherAddress],
      unsafeAllow: ['state-variable-immutable', 'constructor'],
    })
    console.log(`New implementation deployed and validated at: ${newImpl}`)
    console.log(`Admin (${currentAdmin}) must call upgradeToAndCall(${newImpl}, "0x") on the proxy to complete the upgrade.`)
  }

  try {
    const implAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress)
    console.log(`Current implementation: ${implAddress}`)
  } catch {
    console.log('Could not read implementation address from ERC-1967 slot')
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
