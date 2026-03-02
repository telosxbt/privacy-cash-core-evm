const { ethers } = require('hardhat')
const { utils } = ethers
const { prepareTransaction, findUnspentUtxos } = require('../src/index')
const Utxo = require('../src/utxo')
const { signIn } = require('../src/encryption')
const { toFixedHex } = require('../src/utils')
const { ETHER_POOL_ADDRESS, DEPLOY_BLOCK, FEE_RECIPIENT_ADDRESS } = require('./constants')
const WITHDRAW_AMOUNT = process.env.WITHDRAW_AMOUNT || '0.001'
const RECIPIENT = process.env.RECIPIENT
const FLAT_FEE = utils.parseEther('0.00025')
const FEE_RATE = 35 // 0.35% (basis points out of 10000)

async function main() {
  require('./compileHasher')

  const [sender] = await ethers.getSigners()
  const recipient = RECIPIENT || sender.address
  const network = await ethers.provider.getNetwork()
  console.log(`Network: chainId ${network.chainId}`)
  console.log(`Sender: ${sender.address}`)
  console.log(`Recipient: ${recipient}`)
  console.log(`Balance: ${utils.formatEther(await sender.getBalance())} ETH`)

  console.log('\nSigning in to derive keys...')
  const { encryptionKey, keypair } = await signIn(sender)
  console.log(`UTXO pubkey: ${toFixedHex(keypair.pubkey)}`)

  const etherPool = await ethers.getContractAt('EtherPool', ETHER_POOL_ADDRESS)
  console.log(`EtherPool: ${etherPool.address}`)
  console.log(`Pool balance: ${utils.formatEther(await ethers.provider.getBalance(etherPool.address))} ETH`)

  const withdrawAmount = utils.parseEther(WITHDRAW_AMOUNT)

  // Scan on-chain events to find unspent UTXOs
  console.log('\nScanning on-chain events for unspent UTXOs...')
  const unspent = await findUnspentUtxos({ etherPool, encryptionKey, keypair, fromBlock: DEPLOY_BLOCK })
  console.log(`Unspent UTXOs found: ${unspent.length}`)

  if (unspent.length === 0) {
    console.log('No unspent UTXOs available to withdraw.')
    return
  }

  let inputs
  if (unspent.length >= 2) {
    inputs = [unspent[0], unspent[1]]
  } else {
    inputs = [unspent[0]]
  }

  const inputSum = inputs.reduce((sum, u) => sum.add(u.amount), ethers.BigNumber.from(0))
  console.log(`Input UTXOs: ${inputs.length} (total: ${utils.formatEther(inputSum)} ETH)`)

  const feeRecipient = FEE_RECIPIENT_ADDRESS
  const fee = FLAT_FEE.add(withdrawAmount.mul(FEE_RATE).div(10000))
  const recipientAmount = withdrawAmount.sub(fee)
  console.log(`Fee recipient: ${feeRecipient}`)
  console.log(`Fee: ${utils.formatEther(fee)} ETH (0.00025 + 0.35%)`)
  console.log(`Recipient receives: ${utils.formatEther(recipientAmount)} ETH`)

  if (inputSum.lt(withdrawAmount)) {
    console.log(`Insufficient balance. Have ${utils.formatEther(inputSum)} ETH, need ${WITHDRAW_AMOUNT} ETH.`)
    return
  }

  const changeAmount = inputSum.sub(withdrawAmount)
  const outputs = []

  if (changeAmount.gt(0)) {
    outputs.push(new Utxo({ amount: changeAmount, keypair }))
    console.log(`Change UTXO: ${utils.formatEther(changeAmount)} ETH`)
  }

  console.log(`\nWithdrawing ${WITHDRAW_AMOUNT} ETH (${utils.formatEther(recipientAmount)} after fee) to ${recipient}...`)

  const { args, extData } = await prepareTransaction({
    etherPool,
    inputs,
    outputs,
    recipient,
    fee,
    feeRecipient,
    fromBlock: DEPLOY_BLOCK,
    encryptionKey,
  })

  const tx = await etherPool.transact(args, extData, { gasLimit: 3000000 })
  console.log(`Transaction sent: ${tx.hash}`)

  const receipt = await tx.wait()
  console.log(`Confirmed in block ${receipt.blockNumber}, gas used: ${receipt.gasUsed.toString()}`)

  if (changeAmount.gt(0)) {
    console.log(`\nChange UTXO created (${utils.formatEther(changeAmount)} ETH)`)
  }

  console.log(`Pool balance after: ${utils.formatEther(await ethers.provider.getBalance(etherPool.address))} ETH`)
  console.log(`Recipient balance: ${utils.formatEther(await ethers.provider.getBalance(recipient))} ETH`)
  console.log('\nWithdrawal successful!')
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
