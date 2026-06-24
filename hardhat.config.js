/* eslint-disable indent, no-undef */
const { extendEnvironment } = require('hardhat/config')
require('@typechain/hardhat')
require('@nomiclabs/hardhat-ethers')
require('@nomiclabs/hardhat-waffle')
require('@nomicfoundation/hardhat-verify')
require('@openzeppelin/hardhat-upgrades')
require('dotenv').config()

function normalizeRpcResult(method, result) {
  if (result == null) {
    return result
  }

  if (method === 'eth_getTransactionByHash' && result.to === '') {
    result.to = null
  }

  if (
    (method === 'eth_getBlockByNumber' || method === 'eth_getBlockByHash') &&
    Array.isArray(result.transactions)
  ) {
    for (const transaction of result.transactions) {
      if (transaction && transaction.to === '') {
        transaction.to = null
      }
    }
  }

  return result
}

extendEnvironment((hre) => {
  const provider = hre.network.provider
  if (provider.__ethersRpcNormalizePatched) {
    return
  }

  const send = provider.send.bind(provider)
  provider.send = async (method, params) =>
    normalizeRpcResult(method, await send(method, params))
  provider.__ethersRpcNormalizePatched = true
})

task('hasher', 'Compile Poseidon hasher', () => {
  require('./scripts/compileHasher')
})

const config = {
  solidity: {
    compilers: [
      {
        version: '0.8.24',
        settings: {
          optimizer: {
            enabled: true,
            runs: 1,
          },
          viaIR: true,
        },
      },
    ],
  },
  networks: {
    hardhat: {
      chainId: 1,
      hardfork: 'cancun',
      initialBaseFeePerGas: 5,
      loggingEnabled: false,
      allowUnlimitedContractSize: false,
      blockGasLimit: 100000000,
    },
    rinkeby: {
      url: `https://rinkeby.infura.io/v3/${process.env.INFURA_API_KEY}`,
      accounts: process.env.PRIVATE_KEY
        ? [process.env.PRIVATE_KEY]
        : {
            mnemonic: 'test test test test test test test test test test test junk',
          },
    },
    mainnet: {
      url: `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY}`,
      chainId: 1,
      accounts: process.env.PRIVATE_KEY
        ? [process.env.PRIVATE_KEY]
        : {
            mnemonic: 'test test test test test test test test test test test junk',
          },
    },
    baseSepolia: {
      url: `https://base-sepolia.g.alchemy.com/v2/${process.env.ALCHEMY_KEY}`,
      chainId: 84532,
      accounts: process.env.PRIVATE_KEY
        ? [process.env.PRIVATE_KEY]
        : {
            mnemonic: 'test test test test test test test test test test test junk',
          },
    },
    base: {
      url: `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY}`,
      chainId: 8453,
      accounts: process.env.PRIVATE_KEY
        ? [process.env.PRIVATE_KEY]
        : {
            mnemonic: 'test test test test test test test test test test test junk',
          },
    },
    hyperEvmTestnet: {
      url: `https://hyperliquid-testnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY}`,
      chainId: 998,
      accounts: process.env.PRIVATE_KEY
        ? [process.env.PRIVATE_KEY]
        : {
            mnemonic: 'test test test test test test test test test test test junk',
          },
    },
    hyperEvm: {
      url: `https://hyperliquid-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY}`,
      chainId: 999,
      accounts: process.env.PRIVATE_KEY
        ? [process.env.PRIVATE_KEY]
        : {
            mnemonic: 'test test test test test test test test test test test junk',
          },
    },
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_KEY,
    enabled: true,
  },
  sourcify: {
    enabled: false,
  },
  mocha: {
    timeout: 120000,
  },
  typechain: {
    outDir: 'src/types',
  },
}

module.exports = config
