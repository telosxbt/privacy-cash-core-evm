const { ethers } = require('ethers')
const { poseidon2 } = require('poseidon-lite')

const FIELD_SIZE = BigInt(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617',
)

const zeroValue = BigInt(ethers.utils.keccak256(ethers.utils.toUtf8Bytes('privacycash'))) % FIELD_SIZE

const zeros = [zeroValue]
for (let i = 1; i <= 32; i++) {
  zeros[i] = poseidon2([zeros[i - 1], zeros[i - 1]])
}

console.log('// default `zero` value is keccak256("privacycash") %% FIELD_SIZE')
console.log(`// = ${zeroValue.toString()}\n`)

for (let i = 0; i <= 32; i++) {
  const hex = '0x' + zeros[i].toString(16).padStart(64, '0')
  if (i === 0) {
    console.log(`if (i == ${i}) return bytes32(${hex});`)
  } else {
    console.log(`else if (i == ${i}) return bytes32(${hex});`)
  }
}
