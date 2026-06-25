/**
 * Upgrade the deployed ERC-20 privacy pools (USDC/BTC/ETH) to a new ERCPool
 * implementation — e.g. to add depositWithPermit. The pools are UUPS proxies, so
 * we deploy a fresh implementation (same immutable constructor args: verifier2,
 * height, hasher, token) and call upgradeToAndCall on each proxy.
 *
 *   - Only ERC-20 pools are upgraded. The native HYPE pool (EtherPool) has no
 *     permit path and is left untouched.
 *   - Must be run by the pools' admin (the deployer key used at deployment).
 *   - Storage layout is unchanged (depositWithPermit only adds code), so the
 *     upgrade is safe.
 *
 * Usage:
 *   npx hardhat run scripts/upgradePools.js --network hyperEvmTestnet
 */
const fs = require('fs')
const path = require('path')
const { ethers } = require('hardhat')

async function main() {
  require('./compileHasher')
  const [signer] = await ethers.getSigners()
  const net = await ethers.provider.getNetwork()
  const file = path.join(__dirname, '..', 'deployments', `v1-${net.chainId}.json`)
  if (!fs.existsSync(file)) throw new Error(`No deployment at ${file}`)
  const dep = JSON.parse(fs.readFileSync(file))

  console.log(`Network: ${net.name} (${net.chainId})`)
  console.log(`Admin:   ${signer.address}`)

  const Pool = await ethers.getContractFactory('ERCPool')

  for (const [key, info] of Object.entries(dep.pools)) {
    if (info.native || !info.token) {
      console.log(`- skip ${key} (native / no token)`)
      continue
    }
    console.log(`\n== ${key.toUpperCase()} pool ${info.pool} ==`)
    // New implementation with the SAME immutables as the proxy.
    const impl = await Pool.deploy(dep.verifier2, dep.merkleTreeHeight, dep.hasher, info.token)
    await impl.deployed()
    console.log(`  new impl: ${impl.address}`)
    const pool = Pool.attach(info.pool).connect(signer)
    const tx = await pool.upgradeToAndCall(impl.address, '0x')
    await tx.wait()
    console.log(`  upgraded (${tx.hash})`)
    info.impl = impl.address
  }

  fs.writeFileSync(file, JSON.stringify(dep, null, 2))
  console.log(`\nUpdated ${file}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
