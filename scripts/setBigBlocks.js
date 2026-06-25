/**
 * Toggle HyperEVM big blocks for the deployer address.
 *
 * Contract deploys need the big-block lane (30M gas / 1 per min) instead of the
 * default small-block lane (2M gas / 1 per sec). This sends a signed
 * `evmUserModify` L1 action to the HyperLiquid API.
 *
 * Required env:
 *   PRIVATE_KEY   deployer key (same one used for deployment)
 * Optional env:
 *   HL_BIG_BLOCKS  "true" (default) to enable, "false" to go back to small blocks
 *   HL_TESTNET     "true" (default) for testnet, "false" for mainnet
 *
 * Usage:
 *   node scripts/setBigBlocks.js                      # enable on testnet
 *   HL_BIG_BLOCKS=false node scripts/setBigBlocks.js  # disable (back to small blocks)
 *   HL_TESTNET=false node scripts/setBigBlocks.js     # mainnet
 */
require('dotenv').config()
const { ethers } = require('ethers')

const TESTNET = process.env.HL_TESTNET !== 'false'
const ENABLE  = process.env.HL_BIG_BLOCKS !== 'false'
const API     = TESTNET
  ? 'https://api.hyperliquid-testnet.xyz'
  : 'https://api.hyperliquid.xyz'

// ── minimal, order-preserving msgpack encoder (strings, bools, ordered maps) ──
function encStr(s) {
  const b = Buffer.from(s, 'utf8')
  if (b.length < 32) return Buffer.concat([Buffer.from([0xa0 | b.length]), b])
  if (b.length < 256) return Buffer.concat([Buffer.from([0xd9, b.length]), b])
  throw new Error('string too long')
}
function encVal(v) {
  if (typeof v === 'string') return encStr(v)
  if (typeof v === 'boolean') return Buffer.from([v ? 0xc3 : 0xc2])
  throw new Error('unsupported value type: ' + typeof v)
}
// entries: array of [key, value] to preserve order like the python SDK
function encodeAction(entries) {
  if (entries.length > 15) throw new Error('map too large')
  const parts = [Buffer.from([0x80 | entries.length])]
  for (const [k, v] of entries) {
    parts.push(encStr(k), encVal(v))
  }
  return Buffer.concat(parts)
}

function actionHash(actionEntries, nonce) {
  const data = encodeAction(actionEntries)
  const nonceBuf = Buffer.alloc(8)
  nonceBuf.writeBigUInt64BE(BigInt(nonce))
  // vaultAddress = null  -> 0x00 ; no expiresAfter
  const packed = Buffer.concat([data, nonceBuf, Buffer.from([0x00])])
  return ethers.utils.keccak256(packed)
}

async function main() {
  if (!process.env.PRIVATE_KEY) throw new Error('Set PRIVATE_KEY env var')
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY)

  const actionEntries = [
    ['type', 'evmUserModify'],
    ['usingBigBlocks', ENABLE],
  ]
  const action = { type: 'evmUserModify', usingBigBlocks: ENABLE }
  const nonce = Date.now()
  const connectionId = actionHash(actionEntries, nonce)

  const domain = {
    name: 'Exchange',
    version: '1',
    chainId: 1337,
    verifyingContract: '0x0000000000000000000000000000000000000000',
  }
  const types = {
    Agent: [
      { name: 'source', type: 'string' },
      { name: 'connectionId', type: 'bytes32' },
    ],
  }
  const value = { source: TESTNET ? 'b' : 'a', connectionId }

  const sigHex = await wallet._signTypedData(domain, types, value)
  const sig = ethers.utils.splitSignature(sigHex)

  const body = {
    action,
    nonce,
    signature: { r: sig.r, s: sig.s, v: sig.v },
    vaultAddress: null,
  }

  console.log(`Network:  ${TESTNET ? 'testnet' : 'mainnet'} (${API})`)
  console.log(`Address:  ${wallet.address}`)
  console.log(`Big blocks: ${ENABLE ? 'ENABLE' : 'DISABLE'}`)

  const res = await fetch(`${API}/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json()
  console.log('Response:', JSON.stringify(json))
  if (json.status !== 'ok') {
    throw new Error('HyperLiquid rejected the action')
  }
  console.log(`\n✓ Deployer now using ${ENABLE ? 'BIG' : 'small'} blocks`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
