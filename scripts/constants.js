if (!process.env.INDEXER_URL) {
    console.error('Please set INDEXER_URL in .env to run this script')
    process.exit(1)
}

const INDEXER_URL = process.env.INDEXER_URL
const ETHER_POOL_ADDRESS = '0xe689db404EC8779951eeb7d9ed4D5E36bd60F86A'
const DEPLOY_BLOCK = 38235766
const FEE_RECIPIENT_ADDRESS = '0x44eb9939cfdE7C394f1632C6890191d695f0a3ce'

module.exports = {
    INDEXER_URL,
    ETHER_POOL_ADDRESS,
    DEPLOY_BLOCK,
    FEE_RECIPIENT_ADDRESS,
}
