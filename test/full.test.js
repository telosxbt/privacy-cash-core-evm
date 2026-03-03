const hre = require('hardhat')
const { ethers, waffle } = hre
const { loadFixture } = waffle
const { expect } = require('chai')
const { utils } = ethers

const { MerkleTree } = require('fixed-merkle-tree')
const Utxo = require('../src/utxo')
const { toFixedHex, poseidonHash, poseidonHash2, getExtDataHash, FIELD_SIZE } = require('../src/utils')
const { Keypair } = require('../src/keypair')
const { signIn, encrypt, decrypt } = require('../src/encryption')
const { prove } = require('../src/prover')
const { BigNumber } = ethers
const MERKLE_TREE_HEIGHT = 26
const MERKLE_TREE_ZERO_VALUE = '2795675251356313514992617062594790716374808130983166135938897961178374655502'
const MAXIMUM_DEPOSIT_AMOUNT = utils.parseEther('1')

function createEmptyTree() {
  return new MerkleTree(MERKLE_TREE_HEIGHT, [], { hashFunction: poseidonHash2, zeroElement: MERKLE_TREE_ZERO_VALUE })
}

async function getProof({ inputs, outputs, tree, extAmount, fee, recipient, feeRecipient, encryptionKey }) {
  const inputMerklePathIndices = []
  const inputMerklePathElements = []

  for (const input of inputs) {
    if (input.amount.gt(0)) {
      input.index = tree.indexOf(toFixedHex(input.getCommitment()))
      if (input.index < 0) {
        throw new Error(`Input commitment ${toFixedHex(input.getCommitment())} was not found`)
      }
      inputMerklePathIndices.push(input.index)
      inputMerklePathElements.push(tree.path(input.index).pathElements)
    } else {
      inputMerklePathIndices.push(0)
      inputMerklePathElements.push(new Array(MERKLE_TREE_HEIGHT).fill(0))
    }
  }

  let nextIndex = tree._layers[0].length
  for (const output of outputs) {
    output.index = nextIndex++
  }

  const extData = {
    recipient: toFixedHex(recipient, 20),
    extAmount: toFixedHex(extAmount),
    feeRecipient: toFixedHex(feeRecipient, 20),
    fee: toFixedHex(fee),
    encryptedOutput1: outputs[0].encrypt(encryptionKey),
    encryptedOutput2: outputs[1].encrypt(encryptionKey),
  }

  const extDataHash = getExtDataHash(extData)
  const input = {
    root: toFixedHex(tree.root),
    inputNullifier: inputs.map((x) => x.getNullifier().toString()),
    outputCommitment: outputs.map((x) => x.getCommitment().toString()),
    publicAmount: BigNumber.from(extAmount).sub(fee).add(FIELD_SIZE).mod(FIELD_SIZE).toString(),
    extDataHash: extDataHash.toString(),
    mintAddress: inputs[0].mintAddress.toString(),
    inAmount: inputs.map((x) => x.amount.toString()),
    inPrivateKey: inputs.map((x) => x.keypair.privkey.toString()),
    inBlinding: inputs.map((x) => x.blinding.toString()),
    inPathIndices: inputMerklePathIndices,
    inPathElements: inputMerklePathElements,
    outAmount: outputs.map((x) => x.amount.toString()),
    outBlinding: outputs.map((x) => x.blinding.toString()),
    outPubkey: outputs.map((x) => x.keypair.pubkey.toString()),
  }

  const { pA, pB, pC } = await prove(input, `./build/circuits/transaction${inputs.length}`)

  const args = {
    pA, pB, pC,
    root: toFixedHex(input.root),
    inputNullifiers: inputs.map((x) => toFixedHex(x.getNullifier())),
    outputCommitments: outputs.map((x) => toFixedHex(x.getCommitment())),
    publicAmount: toFixedHex(input.publicAmount),
    extDataHash: toFixedHex(extDataHash),
  }

  return { extData, args, outputs }
}

async function prepareTransaction({ tree, inputs = [], outputs = [], fee = 0, recipient = 0, feeRecipient = 0, encryptionKey }) {
  if (inputs.length > 2 || outputs.length > 2) {
    throw new Error('Incorrect inputs/outputs count')
  }
  while (inputs.length < 2) {
    inputs.push(new Utxo())
  }
  while (outputs.length < 2) {
    outputs.push(new Utxo())
  }

  const extAmount = BigNumber.from(fee)
    .add(outputs.reduce((sum, x) => sum.add(x.amount), BigNumber.from(0)))
    .sub(inputs.reduce((sum, x) => sum.add(x.amount), BigNumber.from(0)))

  const { args, extData, outputs: paddedOutputs } = await getProof({
    inputs, outputs, tree, extAmount, fee, recipient, feeRecipient, encryptionKey,
  })

  return { args, extData, outputs: paddedOutputs }
}

async function transaction({ etherPool, tree, ...rest }) {
  const { args, extData, outputs } = await prepareTransaction({ tree, ...rest })

  const overrides = { gasLimit: 3000000 }
  const extAmount = BigNumber.from(extData.extAmount)
  if (extAmount.gt(0)) {
    overrides.value = extAmount
  }

  const receipt = await etherPool.transact(args, extData, overrides)
  const result = await receipt.wait()

  for (const output of outputs) {
    tree.insert(toFixedHex(output.getCommitment()))
  }

  return result
}

describe('EtherPool', function () {


  async function deploy(contractName, ...args) {
    const Factory = await ethers.getContractFactory(contractName)
    const instance = await Factory.deploy(...args)
    return instance.deployed()
  }

  async function fixture() {
    require('../scripts/compileHasher')
    const [sender, gov, admin] = await ethers.getSigners()
    const verifier2 = await deploy('Verifier2')
    const hasher = await deploy('Hasher')

    const EtherPool = await ethers.getContractFactory('EtherPool')
    const implementation = await EtherPool.deploy(
      verifier2.address,
      MERKLE_TREE_HEIGHT,
      hasher.address,
    )
    await implementation.deployed()

    const initData = EtherPool.interface.encodeFunctionData('initialize', [
      MAXIMUM_DEPOSIT_AMOUNT,
      admin.address,
    ])
    const ERC1967Proxy = await ethers.getContractFactory('ERC1967Proxy')
    const proxy = await ERC1967Proxy.deploy(implementation.address, initData)
    await proxy.deployed()

    const etherPool = EtherPool.attach(proxy.address)

    // Derive encryption key and UTXO keypair from sender's signature
    const { encryptionKey, keypair } = await signIn(sender)

    return { etherPool, gov, admin, sender, encryptionKey, keypair }
  }

  it('should configure', async () => {
    const { etherPool, admin } = await loadFixture(fixture)
    const newDepositLimit = utils.parseEther('1337')

    await etherPool.connect(admin).configureLimits(newDepositLimit)

    expect(await etherPool.maximumDepositAmount()).to.be.equal(newDepositLimit)
  })

  it('encrypt -> decrypt should work', async () => {
    const [sender] = await ethers.getSigners()
    const { encryptionKey } = await signIn(sender)

    const data = Buffer.from([0xff, 0xaa, 0x00, 0x01])
    const ciphertext = encrypt(data, encryptionKey)
    const result = decrypt(ciphertext, encryptionKey)
    expect(result).to.be.deep.equal(data)
  })

  it('constants check', async () => {
    const { etherPool } = await loadFixture(fixture)
    const maxFee = await etherPool.MAX_FEE()
    const maxExtAmount = await etherPool.MAX_EXT_AMOUNT()
    const fieldSize = await etherPool.FIELD_SIZE()

    expect(maxExtAmount.add(maxFee)).to.be.lt(fieldSize)
  })

  it('should deposit, transact and withdraw', async function () {
    const { etherPool, encryptionKey, keypair } = await loadFixture(fixture)
    const tree = createEmptyTree()

    // Alice deposits into privacy cash pool
    const aliceDepositAmount = utils.parseEther('0.1')
    const aliceDepositUtxo = new Utxo({ amount: aliceDepositAmount, keypair })
    await transaction({ etherPool, tree, outputs: [aliceDepositUtxo], encryptionKey })

    // Alice withdraws a portion to Bob's address
    const bobEthAddress = '0xDeaD00000000000000000000000000000000BEEf'
    const bobSendAmount = utils.parseEther('0.06')
    const aliceChangeUtxo = new Utxo({
      amount: aliceDepositAmount.sub(bobSendAmount),
      keypair,
    })
    await transaction({
      etherPool, tree,
      inputs: [aliceDepositUtxo],
      outputs: [aliceChangeUtxo],
      recipient: bobEthAddress,
      encryptionKey,
    })

    const bobBalance = await ethers.provider.getBalance(bobEthAddress)
    expect(bobBalance).to.be.equal(bobSendAmount)

    // Alice withdraws the remaining balance
    const aliceEthAddress = '0x000000000000000000000000000000000000dEaD'
    await transaction({
      etherPool, tree,
      inputs: [aliceChangeUtxo],
      outputs: [],
      recipient: aliceEthAddress,
      encryptionKey,
    })

    const aliceBalance = await ethers.provider.getBalance(aliceEthAddress)
    expect(aliceBalance).to.be.equal(aliceDepositAmount.sub(bobSendAmount))
    expect(await ethers.provider.getBalance(etherPool.address)).to.be.equal(0)
  })

  it('should deposit and withdraw with relayer fee', async function () {
    const { etherPool, sender, encryptionKey, keypair } = await loadFixture(fixture)
    const tree = createEmptyTree()
    const [, , , relayer] = await ethers.getSigners()

    const aliceDepositAmount = utils.parseEther('0.1')
    const aliceDepositUtxo = new Utxo({ amount: aliceDepositAmount, keypair })

    const poolBalanceBefore = await ethers.provider.getBalance(etherPool.address)
    expect(poolBalanceBefore).to.be.equal(0)

    const senderBalanceBefore = await ethers.provider.getBalance(sender.address)

    const depositTx = await transaction({ etherPool, tree, outputs: [aliceDepositUtxo], encryptionKey })

    const senderBalanceAfterDeposit = await ethers.provider.getBalance(sender.address)
    const depositGasUsed = utils.parseUnits(depositTx.gasUsed.toString(), 'wei').mul(depositTx.effectiveGasPrice)
    expect(senderBalanceBefore.sub(senderBalanceAfterDeposit)).to.be.equal(aliceDepositAmount.add(depositGasUsed))

    const poolBalanceAfterDeposit = await ethers.provider.getBalance(etherPool.address)
    expect(poolBalanceAfterDeposit).to.be.equal(aliceDepositAmount)

    // Withdraw with relayer fee
    const withdrawAmount = utils.parseEther('0.08')
    const fee = utils.parseEther('0.01')
    const changeAmount = aliceDepositAmount.sub(withdrawAmount).sub(fee)
    const recipient = '0xDeaD00000000000000000000000000000000BEEf'
    const aliceChangeUtxo = new Utxo({
      amount: changeAmount,
      keypair,
    })

    const relayerBalanceBefore = await ethers.provider.getBalance(relayer.address)

    const withdrawTx = await transaction({
      etherPool, tree,
      inputs: [aliceDepositUtxo],
      outputs: [aliceChangeUtxo],
      recipient,
      fee,
      feeRecipient: relayer.address,
      encryptionKey,
    })

    // Recipient gets the withdrawal amount
    const recipientBalance = await ethers.provider.getBalance(recipient)
    expect(recipientBalance).to.be.equal(withdrawAmount)

    // Relayer gets the fee
    const relayerBalanceAfter = await ethers.provider.getBalance(relayer.address)
    expect(relayerBalanceAfter.sub(relayerBalanceBefore)).to.be.equal(fee)

    // Pool retains only the change amount
    const poolBalanceAfterWithdraw = await ethers.provider.getBalance(etherPool.address)
    expect(poolBalanceAfterWithdraw).to.be.equal(changeAmount)

    // Sender paid gas for the withdraw tx but no ETH value
    const senderBalanceAfterWithdraw = await ethers.provider.getBalance(sender.address)
    const withdrawGasUsed = utils.parseUnits(withdrawTx.gasUsed.toString(), 'wei').mul(withdrawTx.effectiveGasPrice)
    expect(senderBalanceAfterDeposit.sub(senderBalanceAfterWithdraw)).to.be.equal(withdrawGasUsed)
  })

  it('should deposit and withdraw with zero fee', async function () {
    const { etherPool, sender, encryptionKey, keypair } = await loadFixture(fixture)
    const tree = createEmptyTree()
    const [, , , relayer] = await ethers.getSigners()

    const aliceDepositAmount = utils.parseEther('0.1')
    const aliceDepositUtxo = new Utxo({ amount: aliceDepositAmount, keypair })

    const poolBalanceBefore = await ethers.provider.getBalance(etherPool.address)
    expect(poolBalanceBefore).to.be.equal(0)

    const senderBalanceBefore = await ethers.provider.getBalance(sender.address)

    const depositTx = await transaction({ etherPool, tree, outputs: [aliceDepositUtxo], encryptionKey })

    const senderBalanceAfterDeposit = await ethers.provider.getBalance(sender.address)
    const depositGasUsed = utils.parseUnits(depositTx.gasUsed.toString(), 'wei').mul(depositTx.effectiveGasPrice)
    expect(senderBalanceBefore.sub(senderBalanceAfterDeposit)).to.be.equal(aliceDepositAmount.add(depositGasUsed))

    const poolBalanceAfterDeposit = await ethers.provider.getBalance(etherPool.address)
    expect(poolBalanceAfterDeposit).to.be.equal(aliceDepositAmount)

    // Withdraw with relayer fee
    const withdrawAmount = utils.parseEther('0.08')
    const fee = 0
    const changeAmount = aliceDepositAmount.sub(withdrawAmount).sub(fee)
    const recipient = '0xDeaD00000000000000000000000000000000BEEf'
    const aliceChangeUtxo = new Utxo({
      amount: changeAmount,
      keypair,
    })

    const relayerBalanceBefore = await ethers.provider.getBalance(relayer.address)

    const withdrawTx = await transaction({
      etherPool, tree,
      inputs: [aliceDepositUtxo],
      outputs: [aliceChangeUtxo],
      recipient,
      fee,
      feeRecipient: relayer.address,
      encryptionKey,
    })

    // Recipient gets the withdrawal amount
    const recipientBalance = await ethers.provider.getBalance(recipient)
    expect(recipientBalance).to.be.equal(withdrawAmount)

    // Relayer gets the fee
    const relayerBalanceAfter = await ethers.provider.getBalance(relayer.address)
    expect(relayerBalanceAfter.sub(relayerBalanceBefore)).to.be.equal(fee)

    // Pool retains only the change amount
    const poolBalanceAfterWithdraw = await ethers.provider.getBalance(etherPool.address)
    expect(poolBalanceAfterWithdraw).to.be.equal(changeAmount)

    // Sender paid gas for the withdraw tx but no ETH value
    const senderBalanceAfterWithdraw = await ethers.provider.getBalance(sender.address)
    const withdrawGasUsed = utils.parseUnits(withdrawTx.gasUsed.toString(), 'wei').mul(withdrawTx.effectiveGasPrice)
    expect(senderBalanceAfterDeposit.sub(senderBalanceAfterWithdraw)).to.be.equal(withdrawGasUsed)
  })

  it('attacker cannot frontrun withdraw by replacing recipient', async function () {
    const { etherPool, encryptionKey, keypair } = await loadFixture(fixture)
    const tree = createEmptyTree()
    const [, , , , attacker] = await ethers.getSigners()

    const aliceDepositAmount = utils.parseEther('0.1')
    const aliceDepositUtxo = new Utxo({ amount: aliceDepositAmount, keypair })
    await transaction({ etherPool, tree, outputs: [aliceDepositUtxo], encryptionKey })

    // Alice prepares a withdrawal to her own address
    const aliceWithdrawAddress = '0xDeaD00000000000000000000000000000000BEEf'
    const { args, extData } = await prepareTransaction({
      tree,
      inputs: [aliceDepositUtxo],
      outputs: [],
      recipient: aliceWithdrawAddress,
      encryptionKey,
    })

    // Attacker intercepts and replaces recipient with their own address
    const attackerExtData = { ...extData, recipient: attacker.address }

    await expect(
      etherPool.transact(args, attackerExtData, { gasLimit: 50e6 }),
    ).to.be.revertedWith('Incorrect external data hash')

    // Verify attacker received nothing
    const attackerBalanceBefore = await ethers.provider.getBalance(attacker.address)

    // Original transaction still works with the correct recipient
    await etherPool.transact(args, extData, { gasLimit: 50e6 })

    const recipientBalance = await ethers.provider.getBalance(aliceWithdrawAddress)
    expect(recipientBalance).to.be.equal(aliceDepositAmount)

    const attackerBalanceAfter = await ethers.provider.getBalance(attacker.address)
    expect(attackerBalanceAfter).to.be.equal(attackerBalanceBefore)
  })

  it('should reject tampered publicAmount', async function () {
    const { etherPool, encryptionKey } = await loadFixture(fixture)
    const tree = createEmptyTree()

    const depositAmount = utils.parseEther('0.05')
    const utxo = new Utxo({ amount: depositAmount })
    const { args, extData } = await prepareTransaction({
      tree,
      outputs: [utxo],
      encryptionKey,
    })

    // Tamper with publicAmount after proof was generated
    args.publicAmount = toFixedHex(42)

    await expect(
      etherPool.transact(args, extData, {
        value: depositAmount,
        gasLimit: 50e6,
      }),
    ).to.be.revertedWith('Invalid public amount')
  })

  it('should reject tampered fee', async function () {
    const { etherPool, encryptionKey } = await loadFixture(fixture)
    const tree = createEmptyTree()

    const depositAmount = utils.parseEther('0.05')
    const utxo = new Utxo({ amount: depositAmount })
    const { args, extData } = await prepareTransaction({
      tree,
      outputs: [utxo],
      encryptionKey,
    })

    // Tamper with fee after proof was generated
    extData.fee = toFixedHex(utils.parseEther('0.01'))

    await expect(
      etherPool.transact(args, extData, {
        value: depositAmount,
        gasLimit: 50e6,
      }),
    ).to.be.revertedWith('Incorrect external data hash')
  })

  it('should reject double spend', async function () {
    const { etherPool, encryptionKey, keypair } = await loadFixture(fixture)
    const tree = createEmptyTree()

    const aliceDepositAmount = utils.parseEther('0.1')
    const aliceDepositUtxo = new Utxo({ amount: aliceDepositAmount, keypair })
    await transaction({ etherPool, tree, outputs: [aliceDepositUtxo], encryptionKey })

    const bobAddress = '0xDeaD00000000000000000000000000000000BEEf'
    const withdrawAmount = utils.parseEther('0.05')
    const aliceChangeUtxo = new Utxo({
      amount: aliceDepositAmount.sub(withdrawAmount),
      keypair,
    })
    await transaction({
      etherPool, tree,
      inputs: [aliceDepositUtxo],
      outputs: [aliceChangeUtxo],
      recipient: bobAddress,
      encryptionKey,
    })

    // Attempt to reuse the same UTXO (double spend)
    const aliceChangeUtxo2 = new Utxo({ amount: 0, keypair })
    await expect(
      transaction({
        etherPool, tree,
        inputs: [aliceDepositUtxo],
        outputs: [aliceChangeUtxo2],
        recipient: bobAddress,
        encryptionKey,
      }),
    ).to.be.revertedWith('Input is already spent')
  })

  it('should reject deposit exceeding limit', async function () {
    const { etherPool, encryptionKey } = await loadFixture(fixture)
    const tree = createEmptyTree()

    const overLimitAmount = MAXIMUM_DEPOSIT_AMOUNT.add(1)
    const utxo = new Utxo({ amount: overLimitAmount })
    await expect(
      transaction({ etherPool, tree, outputs: [utxo], encryptionKey }),
    ).to.be.revertedWith('amount is larger than maximumDepositAmount')
  })

  it('non-admin cannot configure limits', async () => {
    const { etherPool, sender } = await loadFixture(fixture)
    await expect(
      etherPool.connect(sender).configureLimits(utils.parseEther('999')),
    ).to.be.revertedWith('only admin')
  })

  it('should reject direct ETH transfers', async function () {
    const { etherPool, sender } = await loadFixture(fixture)
    await expect(
      sender.sendTransaction({ to: etherPool.address, value: utils.parseEther('1') }),
    ).to.be.revertedWith('Use transact() to deposit')
  })

  it('admin can transfer admin to new address', async function () {
    const { etherPool, admin, gov } = await loadFixture(fixture)

    await etherPool.connect(admin).transferAdmin(gov.address)
    expect(await etherPool.pendingAdmin()).to.equal(gov.address)
    expect(await etherPool.admin()).to.equal(admin.address)

    await etherPool.connect(gov).claimAdmin()
    expect(await etherPool.admin()).to.equal(gov.address)
    expect(await etherPool.pendingAdmin()).to.equal(ethers.constants.AddressZero)
  })

  it('non-admin cannot transfer admin', async function () {
    const { etherPool, sender, gov } = await loadFixture(fixture)
    await expect(
      etherPool.connect(sender).transferAdmin(gov.address),
    ).to.be.revertedWith('only admin')
  })

  it('non-pending admin cannot claim admin', async function () {
    const { etherPool, admin, sender, gov } = await loadFixture(fixture)
    await etherPool.connect(admin).transferAdmin(gov.address)
    await expect(
      etherPool.connect(sender).claimAdmin(),
    ).to.be.revertedWith('not pending admin')
  })

  it('cannot transfer admin to zero address', async function () {
    const { etherPool, admin } = await loadFixture(fixture)
    await expect(
      etherPool.connect(admin).transferAdmin(ethers.constants.AddressZero),
    ).to.be.revertedWith('new admin is zero address')
  })

  it('admin can overwrite pending admin before claim', async function () {
    const { etherPool, admin, gov, sender } = await loadFixture(fixture)

    await etherPool.connect(admin).transferAdmin(gov.address)
    expect(await etherPool.pendingAdmin()).to.equal(gov.address)

    await etherPool.connect(admin).transferAdmin(sender.address)
    expect(await etherPool.pendingAdmin()).to.equal(sender.address)

    await expect(
      etherPool.connect(gov).claimAdmin(),
    ).to.be.revertedWith('not pending admin')

    await etherPool.connect(sender).claimAdmin()
    expect(await etherPool.admin()).to.equal(sender.address)
  })

  it('new admin can configure limits after transfer', async function () {
    const { etherPool, admin, gov } = await loadFixture(fixture)

    await etherPool.connect(admin).transferAdmin(gov.address)
    await etherPool.connect(gov).claimAdmin()

    const newLimit = utils.parseEther('500')
    await etherPool.connect(gov).configureLimits(newLimit)
    expect(await etherPool.maximumDepositAmount()).to.equal(newLimit)

    await expect(
      etherPool.connect(admin).configureLimits(utils.parseEther('1')),
    ).to.be.revertedWith('only admin')
  })

  it('cannot initialize twice', async function () {
    const { etherPool, admin } = await loadFixture(fixture)
    await expect(
      etherPool.connect(admin).initialize(utils.parseEther('2'), admin.address),
    ).to.be.reverted
  })

  it('should deposit and withdraw full amount, then deposit again', async function () {
    const { etherPool, encryptionKey } = await loadFixture(fixture)
    const tree = createEmptyTree()

    // First cycle: deposit and withdraw everything
    const depositAmount1 = utils.parseEther('0.1')
    const depositUtxo1 = new Utxo({ amount: depositAmount1 })
    await transaction({ etherPool, tree, outputs: [depositUtxo1], encryptionKey })

    const recipient1 = '0xDeaD00000000000000000000000000000000BEEf'
    await transaction({
      etherPool, tree,
      inputs: [depositUtxo1],
      outputs: [],
      recipient: recipient1,
      encryptionKey,
    })

    expect(await ethers.provider.getBalance(recipient1)).to.be.equal(depositAmount1)
    expect(await ethers.provider.getBalance(etherPool.address)).to.be.equal(0)

    // Second cycle: deposit again after pool was fully drained
    const depositAmount2 = utils.parseEther('0.05')
    const depositUtxo2 = new Utxo({ amount: depositAmount2 })
    await transaction({ etherPool, tree, outputs: [depositUtxo2], encryptionKey })

    expect(await ethers.provider.getBalance(etherPool.address)).to.be.equal(depositAmount2)

    // Withdraw from the second deposit
    const recipient2 = '0x000000000000000000000000000000000000dEaD'
    await transaction({
      etherPool, tree,
      inputs: [depositUtxo2],
      outputs: [],
      recipient: recipient2,
      encryptionKey,
    })

    expect(await ethers.provider.getBalance(recipient2)).to.be.equal(depositAmount2)
    expect(await ethers.provider.getBalance(etherPool.address)).to.be.equal(0)
  })

  it('can deposit after increasing limit', async function () {
    const { etherPool, admin, encryptionKey } = await loadFixture(fixture)
    const tree = createEmptyTree()

    const largeAmount = utils.parseEther('5')
    const utxo = new Utxo({ amount: largeAmount })

    // Should fail with default limit (1 ETH)
    await expect(
      transaction({ etherPool, tree, outputs: [utxo], encryptionKey }),
    ).to.be.revertedWith('amount is larger than maximumDepositAmount')

    // Increase limit
    await etherPool.connect(admin).configureLimits(utils.parseEther('1000'))

    // Should now succeed
    await transaction({ etherPool, tree, outputs: [utxo], encryptionKey })
    expect(await ethers.provider.getBalance(etherPool.address)).to.be.equal(largeAmount)
  })

  it('cannot deposit after decreasing limit', async function () {
    const { etherPool, admin, encryptionKey } = await loadFixture(fixture)
    const tree = createEmptyTree()

    // Deposit 0.5 ETH (within default 1 ETH limit)
    const depositUtxo = new Utxo({ amount: utils.parseEther('0.5') })
    await transaction({ etherPool, tree, outputs: [depositUtxo], encryptionKey })

    // Decrease limit to 0.1 ETH
    await etherPool.connect(admin).configureLimits(utils.parseEther('0.1'))

    // Now 0.5 ETH deposit should fail
    const utxo = new Utxo({ amount: utils.parseEther('0.5') })
    await expect(
      transaction({ etherPool, tree, outputs: [utxo], encryptionKey }),
    ).to.be.revertedWith('amount is larger than maximumDepositAmount')
  })

  it('withdrawal has no limit', async function () {
    const { etherPool, admin, encryptionKey } = await loadFixture(fixture)
    const tree = createEmptyTree()

    // Set limit high enough for initial deposit
    await etherPool.connect(admin).configureLimits(utils.parseEther('200'))

    // Deposit 100 ETH
    const depositAmount = utils.parseEther('100')
    const depositUtxo = new Utxo({ amount: depositAmount })
    await transaction({ etherPool, tree, outputs: [depositUtxo], encryptionKey })

    expect(await ethers.provider.getBalance(etherPool.address)).to.be.equal(depositAmount)

    // Lower deposit limit to 50 ETH
    await etherPool.connect(admin).configureLimits(utils.parseEther('50'))

    // Verify new 100 ETH deposit fails
    const blockedUtxo = new Utxo({ amount: depositAmount })
    await expect(
      transaction({ etherPool, tree, outputs: [blockedUtxo], encryptionKey }),
    ).to.be.revertedWith('amount is larger than maximumDepositAmount')

    // Withdraw the full 100 ETH -- should succeed despite 50 ETH deposit limit
    const recipient = '0xDeaD00000000000000000000000000000000BEEf'
    await transaction({
      etherPool, tree,
      inputs: [depositUtxo],
      outputs: [],
      recipient,
      encryptionKey,
    })

    expect(await ethers.provider.getBalance(recipient)).to.be.equal(depositAmount)
    expect(await ethers.provider.getBalance(etherPool.address)).to.be.equal(0)
  })

  it('arithmetic overflow protection', async function () {
    const { etherPool, encryptionKey } = await loadFixture(fixture)
    const tree = createEmptyTree()

    const depositAmount = utils.parseEther('0.05')
    const utxo = new Utxo({ amount: depositAmount })
    const { args, extData } = await prepareTransaction({
      tree,
      outputs: [utxo],
      encryptionKey,
    })

    // Set publicAmount to max uint256 (would overflow in unchecked math)
    args.publicAmount = ethers.constants.MaxUint256.toHexString()

    await expect(
      etherPool.transact(args, extData, {
        value: depositAmount,
        gasLimit: 50e6,
      }),
    ).to.be.reverted
  })

  it('should deposit with zero fee and withdraw with positive fee', async function () {
    const { etherPool, encryptionKey } = await loadFixture(fixture)
    const tree = createEmptyTree()
    const [, , , relayer] = await ethers.getSigners()

    // Deposit with zero fee
    const depositAmount = utils.parseEther('0.1')
    const depositUtxo = new Utxo({ amount: depositAmount })
    await transaction({ etherPool, tree, outputs: [depositUtxo], fee: 0, encryptionKey })

    expect(await ethers.provider.getBalance(etherPool.address)).to.be.equal(depositAmount)

    // Withdraw with positive relayer fee
    const withdrawFee = utils.parseEther('0.02')
    const recipient = '0xDeaD00000000000000000000000000000000BEEf'
    await transaction({
      etherPool, tree,
      inputs: [depositUtxo],
      outputs: [],
      recipient,
      fee: withdrawFee,
      feeRecipient: relayer.address,
      encryptionKey,
    })

    const recipientBalance = await ethers.provider.getBalance(recipient)
    expect(recipientBalance).to.be.equal(depositAmount.sub(withdrawFee))
    expect(await ethers.provider.getBalance(etherPool.address)).to.be.equal(0)
  })

  it('should reject incorrect ETH value on deposit', async function () {
    const { etherPool, encryptionKey } = await loadFixture(fixture)
    const tree = createEmptyTree()

    const depositAmount = utils.parseEther('0.05')
    const utxo = new Utxo({ amount: depositAmount })
    const { args, extData } = await prepareTransaction({
      tree,
      outputs: [utxo],
      encryptionKey,
    })
    // Send wrong msg.value (too little)
    await expect(
      etherPool.transact(args, extData, {
        value: depositAmount.sub(1),
        gasLimit: 50e6,
      }),
    ).to.be.revertedWith('Incorrect ETH value')
  })

  it('should reject withdraw to zero address', async function () {
    const { etherPool, encryptionKey } = await loadFixture(fixture)
    const tree = createEmptyTree()

    const depositAmount = utils.parseEther('0.05')
    const depositUtxo = new Utxo({ amount: depositAmount })
    await transaction({ etherPool, tree, outputs: [depositUtxo], encryptionKey })

    await expect(
      transaction({
        etherPool, tree,
        inputs: [depositUtxo],
        outputs: [],
        recipient: '0x0000000000000000000000000000000000000000',
        encryptionKey,
      }),
    ).to.be.revertedWith("Can't withdraw to zero address")
  })

  it('should reject unknown root', async function () {
    const { etherPool, encryptionKey } = await loadFixture(fixture)
    const tree = createEmptyTree()

    const depositAmount = utils.parseEther('0.05')
    const utxo = new Utxo({ amount: depositAmount })
    const { args, extData } = await prepareTransaction({
      tree,
      outputs: [utxo],
      encryptionKey,
    })

    // Replace root with an unknown value
    args.root = toFixedHex(123456789)

    await expect(
      etherPool.transact(args, extData, {
        value: depositAmount,
        gasLimit: 50e6,
      }),
    ).to.be.revertedWith('Invalid merkle root')
  })

  it('should reject zero root', async function () {
    const { etherPool, encryptionKey } = await loadFixture(fixture)
    const tree = createEmptyTree()

    const depositAmount = utils.parseEther('0.05')
    const utxo = new Utxo({ amount: depositAmount })
    const { args, extData } = await prepareTransaction({
      tree,
      outputs: [utxo],
      encryptionKey,
    })

    args.root = toFixedHex(0)

    await expect(
      etherPool.transact(args, extData, {
        value: depositAmount,
        gasLimit: 50e6,
      }),
    ).to.be.revertedWith('Invalid merkle root')
  })

  it('should reject wrong extDataHash', async function () {
    const { etherPool, encryptionKey } = await loadFixture(fixture)
    const tree = createEmptyTree()

    const depositAmount = utils.parseEther('0.05')
    const utxo = new Utxo({ amount: depositAmount })
    const { args, extData } = await prepareTransaction({
      tree,
      outputs: [utxo],
      encryptionKey,
    })

    // Tamper with extData after proof was generated (changing recipient)
    const tamperedExtData = { ...extData, recipient: '0xDeaD00000000000000000000000000000000BEEf' }

    await expect(
      etherPool.transact(args, tamperedExtData, {
        value: depositAmount,
        gasLimit: 50e6,
      }),
    ).to.be.revertedWith('Incorrect external data hash')
  })

  it('should reject zero extAmount (no shielded transfers)', async function () {
    const { etherPool } = await loadFixture(fixture)
    await expect(
      etherPool.calculatePublicAmount(0, 0),
    ).to.be.revertedWith('ext amount must exceed fee for deposits')
  })

  it('should reject zero extAmount with positive fee', async function () {
    const { etherPool } = await loadFixture(fixture)
    await expect(
      etherPool.calculatePublicAmount(0, utils.parseEther('0.01')),
    ).to.be.revertedWith('ext amount must exceed fee for deposits')
  })

  it('should reject deposit where fee equals extAmount', async function () {
    const { etherPool } = await loadFixture(fixture)
    const amount = utils.parseEther('0.1')
    await expect(
      etherPool.calculatePublicAmount(amount, amount),
    ).to.be.revertedWith('ext amount must exceed fee for deposits')
  })

  it('should reject deposit where fee exceeds extAmount', async function () {
    const { etherPool } = await loadFixture(fixture)
    await expect(
      etherPool.calculatePublicAmount(utils.parseEther('0.05'), utils.parseEther('0.1')),
    ).to.be.revertedWith('ext amount must exceed fee for deposits')
  })

  it('should reject withdrawal where fee equals extAmount', async function () {
    const { etherPool } = await loadFixture(fixture)
    const amount = utils.parseEther('0.1')
    await expect(
      etherPool.calculatePublicAmount(amount.mul(-1), amount),
    ).to.be.revertedWith('ext amount must exceed fee for deposits')
  })

  it('should reject withdrawal where fee exceeds extAmount', async function () {
    const { etherPool } = await loadFixture(fixture)
    await expect(
      etherPool.calculatePublicAmount(utils.parseEther('-0.05'), utils.parseEther('0.1')),
    ).to.be.revertedWith('ext amount must exceed fee for deposits')
  })

  it('should accept deposit where extAmount exceeds fee', async function () {
    const { etherPool } = await loadFixture(fixture)
    const result = await etherPool.calculatePublicAmount(
      utils.parseEther('0.1'),
      utils.parseEther('0.01'),
    )
    expect(result).to.be.equal(utils.parseEther('0.09'))
  })

  it('should accept withdrawal where extAmount exceeds fee', async function () {
    const { etherPool } = await loadFixture(fixture)
    const fieldSize = await etherPool.FIELD_SIZE()
    const result = await etherPool.calculatePublicAmount(
      utils.parseEther('-0.1'),
      utils.parseEther('0.01'),
    )
    expect(result).to.be.equal(fieldSize.sub(utils.parseEther('0.11')))
  })

  it('should accept deposit with zero fee', async function () {
    const { etherPool } = await loadFixture(fixture)
    const result = await etherPool.calculatePublicAmount(utils.parseEther('0.1'), 0)
    expect(result).to.be.equal(utils.parseEther('0.1'))
  })

  it('should accept withdrawal with zero fee', async function () {
    const { etherPool } = await loadFixture(fixture)
    const fieldSize = await etherPool.FIELD_SIZE()
    const result = await etherPool.calculatePublicAmount(utils.parseEther('-0.1'), 0)
    expect(result).to.be.equal(fieldSize.sub(utils.parseEther('0.1')))
  })

  it('should be compliant', async function () {
    // basically verifier should check if a commitment and a nullifier hash are on chain
    const { etherPool, encryptionKey } = await loadFixture(fixture)
    const tree = createEmptyTree()
    const aliceDepositAmount = utils.parseEther('0.07')
    const aliceDepositUtxo = new Utxo({ amount: aliceDepositAmount })
    const [sender] = await ethers.getSigners()

    const { args, extData, outputs: depositOutputs } = await prepareTransaction({
      tree,
      outputs: [aliceDepositUtxo],
      encryptionKey,
    })
    const receipt = await etherPool.transact(args, extData, {
      value: aliceDepositAmount,
      gasLimit: 50e6,
    })
    await receipt.wait()
    for (const output of depositOutputs) {
      tree.insert(toFixedHex(output.getCommitment()))
    }

    // withdrawal
    await transaction({
      etherPool, tree,
      inputs: [aliceDepositUtxo],
      outputs: [],
      recipient: sender.address,
      encryptionKey,
    })

    const commitment = aliceDepositUtxo.getCommitment()
    const index = tree.indexOf(toFixedHex(commitment))
    aliceDepositUtxo.index = index
    const nullifier = aliceDepositUtxo.getNullifier()

    // commitment = hash(amount, pubKey, blinding, mintAddress)
    // nullifier = hash(commitment, merklePath, sign(merklePath, privKey))
    const dataForVerifier = {
      commitment: {
        amount: aliceDepositUtxo.amount,
        pubkey: aliceDepositUtxo.keypair.pubkey,
        blinding: aliceDepositUtxo.blinding,
        mintAddress: aliceDepositUtxo.mintAddress,
      },
      nullifier: {
        commitment,
        merklePath: index,
        signature: aliceDepositUtxo.keypair.sign(commitment, index),
      },
    }

    // generateReport(dataForVerifier) -> compliance report
    // on the verifier side we compute commitment and nullifier and then check them onchain
    const commitmentV = poseidonHash([...Object.values(dataForVerifier.commitment)])
    const nullifierV = poseidonHash([
      commitmentV,
      dataForVerifier.nullifier.merklePath,
      dataForVerifier.nullifier.signature,
    ])

    expect(commitmentV).to.be.equal(commitment)
    expect(nullifierV).to.be.equal(nullifier)
    expect(await etherPool.nullifierHashes(nullifierV)).to.be.equal(true)
    // expect commitmentV present onchain (it will be in NewCommitment events)

    // in report we can see the tx with NewCommitment event (this is how alice got money)
    // and the tx with NewNullifier event is where alice spent the UTXO
  })
})

describe('toFixedHex negative numbers', function () {
  it('should produce correct length for positive numbers', function () {
    const result = toFixedHex(5)
    expect(result).to.have.lengthOf(66) // "0x" + 64 hex chars
    expect(result).to.equal('0x' + '0'.repeat(63) + '5')
    expect(ethers.BigNumber.from(result).toNumber()).to.equal(5)
  })

  it('should roundtrip negative numbers through BigNumber', function () {
    const values = [-1, -5, -1000, '-1000000000000000000']
    for (const v of values) {
      const hex = toFixedHex(v)
      const recovered = ethers.BigNumber.from(hex)
      expect(recovered.eq(ethers.BigNumber.from(v))).to.be.true
    }
  })

  it('should roundtrip negative numbers through toFixedHex', function () {
    const neg = toFixedHex(-5)
    expect(ethers.BigNumber.from(neg).toNumber()).to.equal(-5)
  })

  it('should produce correct extDataHash with negative extAmount', function () {
    const { getExtDataHash } = require('../src/utils')
    const extData = {
      recipient: toFixedHex('0x' + '1'.repeat(40), 20),
      extAmount: toFixedHex(ethers.utils.parseEther('-0.1')),
      feeRecipient: toFixedHex(0, 20),
      fee: toFixedHex(0),
      encryptedOutput1: '0x00',
      encryptedOutput2: '0x00',
    }
    // should not throw
    const hash = getExtDataHash(extData)
    expect(hash).to.not.be.undefined
  })
})
