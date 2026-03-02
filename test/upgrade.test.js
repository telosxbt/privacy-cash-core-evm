const hre = require('hardhat')
const { ethers, upgrades, waffle } = hre
const { loadFixture } = waffle
const { expect } = require('chai')
const { utils } = ethers

const MERKLE_TREE_HEIGHT = 26
const MAXIMUM_DEPOSIT_AMOUNT = utils.parseEther('1')

describe('EtherPool Upgrades', function () {

  upgrades.silenceWarnings()

  async function deploy(contractName, ...args) {
    const Factory = await ethers.getContractFactory(contractName)
    const instance = await Factory.deploy(...args)
    return instance.deployed()
  }

  async function fixture() {
    require('../scripts/compileHasher')
    const [sender, , admin] = await ethers.getSigners()
    const verifier2 = await deploy('Verifier2')
    const hasher = await deploy('Hasher')

    const EtherPool = await ethers.getContractFactory('EtherPool')
    const etherPool = await upgrades.deployProxy(
      EtherPool,
      [MAXIMUM_DEPOSIT_AMOUNT, admin.address],
      {
        kind: 'uups',
        initializer: 'initialize',
        constructorArgs: [verifier2.address, MERKLE_TREE_HEIGHT, hasher.address],
        unsafeAllow: ['state-variable-immutable', 'constructor'],
      },
    )
    await etherPool.deployed()

    return { etherPool, verifier2, hasher, admin, sender }
  }

  describe('deployProxy', () => {
    it('should deploy via upgrades plugin and initialize correctly', async () => {
      const { etherPool, admin } = await loadFixture(fixture)
      expect(await etherPool.admin()).to.equal(admin.address)
      expect(await etherPool.maximumDepositAmount()).to.equal(MAXIMUM_DEPOSIT_AMOUNT)
    })

    it('should have correct merkle tree initial state', async () => {
      const { etherPool } = await loadFixture(fixture)
      expect(await etherPool.nextIndex()).to.equal(0)
      expect(await etherPool.currentRootIndex()).to.equal(0)
      const root = await etherPool.getLastRoot()
      expect(root).to.not.equal(ethers.constants.HashZero)
    })

    it('should not allow re-initialization', async () => {
      const { etherPool, admin } = await loadFixture(fixture)
      await expect(
        etherPool.initialize(MAXIMUM_DEPOSIT_AMOUNT, admin.address),
      ).to.be.reverted
    })
  })

  describe('upgradeProxy', () => {
    it('should upgrade and preserve storage', async () => {
      const { etherPool, verifier2, hasher, admin } = await loadFixture(fixture)

      const newLimit = utils.parseEther('5')
      await etherPool.connect(admin).configureLimits(newLimit)
      expect(await etherPool.maximumDepositAmount()).to.equal(newLimit)

      const EtherPoolV2 = await ethers.getContractFactory('EtherPoolV2Mock', admin)
      const upgradeOpts = {
        kind: 'uups',
        constructorArgs: [verifier2.address, MERKLE_TREE_HEIGHT, hasher.address],
        unsafeAllow: ['state-variable-immutable', 'constructor', 'missing-initializer-call'],
        call: { fn: 'initializeV2', args: [42] },
      }
      const upgraded = await upgrades.upgradeProxy(etherPool.address, EtherPoolV2, upgradeOpts)

      expect(await upgraded.admin()).to.equal(admin.address)
      expect(await upgraded.maximumDepositAmount()).to.equal(newLimit)
      expect(await upgraded.version()).to.equal(2)
      expect(await upgraded.newVariable()).to.equal(42)

      const root = await upgraded.getLastRoot()
      expect(root).to.not.equal(ethers.constants.HashZero)
    })

    it('should reject upgrade from non-admin', async () => {
      const { etherPool, verifier2, hasher, sender } = await loadFixture(fixture)

      const EtherPoolV2 = await ethers.getContractFactory('EtherPoolV2Mock')
      const newImpl = await EtherPoolV2.deploy(verifier2.address, MERKLE_TREE_HEIGHT, hasher.address)
      await newImpl.deployed()

      await expect(
        etherPool.connect(sender).upgradeToAndCall(newImpl.address, '0x'),
      ).to.be.revertedWith('only admin')
    })

    it('should allow admin to upgrade after admin transfer', async () => {
      const { etherPool, verifier2, hasher, admin, sender } = await loadFixture(fixture)

      await etherPool.connect(admin).transferAdmin(sender.address)
      await etherPool.connect(sender).claimAdmin()
      expect(await etherPool.admin()).to.equal(sender.address)

      const EtherPoolV2 = await ethers.getContractFactory('EtherPoolV2Mock', sender)
      const upgraded = await upgrades.upgradeProxy(etherPool.address, EtherPoolV2, {
        kind: 'uups',
        constructorArgs: [verifier2.address, MERKLE_TREE_HEIGHT, hasher.address],
        unsafeAllow: ['state-variable-immutable', 'constructor', 'missing-initializer-call'],
        call: { fn: 'initializeV2', args: [99] },
      })

      expect(await upgraded.admin()).to.equal(sender.address)
      expect(await upgraded.version()).to.equal(2)
    })
  })
})
