import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ethers } from 'ethers'
import { connectProvider, escrowRelease, signAndBroadcast, withRpcTimeout } from '../src/chains.js'

const DEAD = 'http://127.0.0.1:1'
const ESCROW = '0x000000000000000000000000000000000000dEaD'

test('withRpcTimeout rejects with "RPC <url> unreachable" when the read never settles', async () => {
  await assert.rejects(withRpcTimeout(new Promise(() => {}), DEAD, 50), /RPC http:\/\/127\.0\.0\.1:1 unreachable/)
})

test('a dead RPC rejects within the timeout instead of retrying network detection', async () => {
  process.env.PSILOCLI_RPC_TIMEOUT_MS = '2000'
  try {
    const started = Date.now()
    await assert.rejects(connectProvider(DEAD, '31337'), /RPC http:\/\/127\.0\.0\.1:1 unreachable/)
    // escrowRelease is what release-payment's .catch fallback wraps.
    await assert.rejects(escrowRelease(null, ESCROW, '31337', DEAD), /RPC http:\/\/127\.0\.0\.1:1 unreachable/)
    const tx = { to: ESCROW, data: '0x', value: '0', chainId: '31337' }
    await assert.rejects(signAndBroadcast(null, ethers.Wallet.createRandom().privateKey, tx, DEAD), /unreachable/)
    assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`)
  } finally {
    delete process.env.PSILOCLI_RPC_TIMEOUT_MS
  }
})

test('an RPC that accepts the connection but never answers times out', async () => {
  const { createServer } = await import('node:http')
  const server = createServer(() => {}) // never responds
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}`
  process.env.PSILOCLI_RPC_TIMEOUT_MS = '300'
  try {
    const started = Date.now()
    await assert.rejects(escrowRelease(null, ESCROW, '31337', url), /unreachable \(no answer within 300 ms/)
    assert.ok(Date.now() - started < 2000)
  } finally {
    delete process.env.PSILOCLI_RPC_TIMEOUT_MS
    server.closeAllConnections()
    server.close()
  }
})
