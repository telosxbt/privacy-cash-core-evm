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

  // OZ Contracts v5.x removed upgradeTo(); only upgradeToAndCall() exists.
  // Use prepareUpgrade for validation + deployment, then call upgradeToAndCall directly.
  const newImpl = await upgrades.prepareUpgrade(proxyAddress, EtherPoolV2, {
    kind: 'uups',
    constructorArgs: [verifier2Address, levels, hasherAddress],
    unsafeAllow: ['state-variable-immutable', 'constructor'],
  })
  console.log(`New implementation deployed and validated at: ${newImpl}`)

  if (deployer.address.toLowerCase() === currentAdmin.toLowerCase()) {
    const tx = await proxy.upgradeToAndCall(newImpl, '0x')
    await tx.wait()
    console.log(`EtherPool upgraded at proxy: ${proxyAddress}`)
  } else {
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
