if (!process.env.INDEXER_URL) {
    console.error('Please set INDEXER_URL in .env to run this script')
    process.exit(1)
}

const INDEXER_URL = process.env.INDEXER_URL
const ETHER_POOL_ADDRESS = '0x51450B59ec2Bc26852415cB1047DF31772aD9cD5'
const DEPLOY_BLOCK = 38394919
const FEE_RECIPIENT_ADDRESS = '0x44eb9939cfdE7C394f1632C6890191d695f0a3ce'

module.exports = {
    INDEXER_URL,
    ETHER_POOL_ADDRESS,
    DEPLOY_BLOCK,
    FEE_RECIPIENT_ADDRESS,
}
