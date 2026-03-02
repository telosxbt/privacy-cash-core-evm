const { ethers } = require('hardhat')
const { utils } = ethers
const { findUnspentUtxos } = require('../src/index')
const { signIn } = require('../src/encryption')
const { toFixedHex } = require('../src/utils')
const { ETHER_POOL_ADDRESS, DEPLOY_BLOCK } = require('./constants')

async function main() {
  require('./compileHasher')

  const [sender] = await ethers.getSigners()

  console.log('Signing in to derive keys...')
  const { encryptionKey, keypair } = await signIn(sender)
  console.log(`UTXO pubkey: ${toFixedHex(keypair.pubkey)}`)

  const etherPool = await ethers.getContractAt('EtherPool', ETHER_POOL_ADDRESS)
  const poolBalance = await ethers.provider.getBalance(etherPool.address)
  console.log(`EtherPool: ${etherPool.address}`)
  console.log(`Pool on-chain balance: ${utils.formatEther(poolBalance)} ETH`)

  // Scan on-chain events and decrypt to find our UTXOs
  console.log('\nScanning on-chain events...')
  const unspent = await findUnspentUtxos({ etherPool, encryptionKey, keypair, fromBlock: DEPLOY_BLOCK })

  console.log(`\nUnspent UTXOs: ${unspent.length}`)
  let total = ethers.BigNumber.from(0)
  for (let i = 0; i < unspent.length; i++) {
    const utxo = unspent[i]
    console.log(`  #${i}: ${utils.formatEther(utxo.amount)} ETH (index: ${utxo.index})`)
    total = total.add(utxo.amount)
  }

  console.log(`\nTotal unspent: ${utils.formatEther(total)} ETH`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
