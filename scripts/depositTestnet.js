const { ethers } = require('hardhat')
const { utils } = ethers
const { prepareTransaction, findUnspentUtxos } = require('../src/index')
const Utxo = require('../src/utxo')
const { signIn } = require('../src/encryption')
const { toFixedHex } = require('../src/utils')
const { ETHER_POOL_ADDRESS, DEPLOY_BLOCK } = require('./constants')
const DEPOSIT_AMOUNT = process.env.DEPOSIT_AMOUNT || '0.001'

async function main() {
  require('./compileHasher')

  const [sender] = await ethers.getSigners()
  const network = await ethers.provider.getNetwork()
  console.log(`Network: chainId ${network.chainId}`)
  console.log(`Depositor: ${sender.address}`)
  console.log(`Balance: ${utils.formatEther(await sender.getBalance())} ETH`)

  console.log('\nSigning in to derive keys...')
  const { encryptionKey, keypair } = await signIn(sender)
  console.log(`UTXO pubkey: ${toFixedHex(keypair.pubkey)}`)

  const etherPool = await ethers.getContractAt('EtherPool', ETHER_POOL_ADDRESS)
  console.log(`EtherPool: ${etherPool.address}`)
  console.log(`Pool balance: ${utils.formatEther(await ethers.provider.getBalance(etherPool.address))} ETH`)

  const depositAmount = utils.parseEther(DEPOSIT_AMOUNT)

  const maxDeposit = await etherPool.maximumDepositAmount()
  if (depositAmount.gt(maxDeposit)) {
    console.log(`Deposit amount ${DEPOSIT_AMOUNT} ETH exceeds pool limit of ${utils.formatEther(maxDeposit)} ETH`)
    return
  }

  // Scan on-chain events to find unspent UTXOs
  console.log('\nScanning on-chain events for unspent UTXOs...')
  const unspent = await findUnspentUtxos({ etherPool, encryptionKey, keypair, fromBlock: DEPLOY_BLOCK })
  console.log(`Unspent UTXOs found: ${unspent.length}`)

  let inputs = []
  let inputSum = ethers.BigNumber.from(0)

  if (unspent.length >= 2) {
    inputs = [unspent[0], unspent[1]]
    inputSum = inputs[0].amount.add(inputs[1].amount)
    console.log(`Using 2 existing UTXOs as inputs (${utils.formatEther(inputSum)} ETH)`)
  } else if (unspent.length === 1) {
    inputs = [unspent[0]]
    inputSum = inputs[0].amount
    console.log(`Using 1 existing UTXO as input (${utils.formatEther(inputSum)} ETH)`)
  } else {
    console.log('No existing UTXOs, creating fresh deposit')
  }

  const outputAmount = inputSum.add(depositAmount)
  const outputUtxo = new Utxo({ amount: outputAmount, keypair })

  console.log(`Depositing ${DEPOSIT_AMOUNT} ETH (new output: ${utils.formatEther(outputAmount)} ETH)`)

  const { args, extData } = await prepareTransaction({
    etherPool,
    inputs,
    outputs: [outputUtxo],
    fromBlock: DEPLOY_BLOCK,
    encryptionKey,
  })

  const tx = await etherPool.transact(args, extData, {
    value: depositAmount,
    gasLimit: 3000000,
  })
  console.log(`Transaction sent: ${tx.hash}`)

  const receipt = await tx.wait()
  console.log(`Confirmed in block ${receipt.blockNumber}, gas used: ${receipt.gasUsed.toString()}`)

  console.log(`\nNew UTXO created (${utils.formatEther(outputAmount)} ETH)`)
  console.log(`Pool balance after: ${utils.formatEther(await ethers.provider.getBalance(etherPool.address))} ETH`)
  console.log(`Sender balance after: ${utils.formatEther(await sender.getBalance())} ETH`)
  console.log('\nDeposit successful!')
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
