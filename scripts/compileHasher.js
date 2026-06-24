// Generates Hasher artifact at compile-time using external compilermechanism
const path = require('path')
const fs = require('fs')
const genContract = require('circomlibjs').poseidonContract
const outputPath = path.join(__dirname, '..', 'artifacts', 'contracts', 'Hasher.sol')
const outputFile = path.join(outputPath, 'Hasher.json')

if (!fs.existsSync(outputPath)) {
  fs.mkdirSync(outputPath, { recursive: true })
}

const bytecode = genContract.createCode(2)
const contract = {
  _format: 'hh-sol-artifact-1',
  sourceName: 'contracts/Hasher.sol',
  linkReferences: {},
  deployedLinkReferences: {},
  contractName: 'Hasher',
  abi: genContract.generateABI(2),
  bytecode,
  deployedBytecode: bytecode,
}

fs.writeFileSync(outputFile, JSON.stringify(contract, null, 2))
