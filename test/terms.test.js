import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Interface, Wallet } from 'ethers'

const here = dirname(fileURLToPath(import.meta.url))
const BIN = join(here, '..', 'bin', 'psilocli.mjs')
const VECTOR = join(here, 'fixtures', 'v1-basic.json')
const EXPECTED = JSON.parse(readFileSync(join(here, 'fixtures', 'expected.json'), 'utf8'))['v1-basic_keccak256']
const tmp = mkdtempSync(join(tmpdir(), 'psilocli-terms-'))
const KEY = '0x' + '11'.repeat(32)
const ESCROW = '0x' + 'ab'.repeat(20)
const FACTORY = '0x' + 'cd'.repeat(20)

function cli(args, { env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, AGENT_PRIVATE_KEY: KEY, AGENT_ADDRESS: new Wallet(KEY).address, ...env },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

function termsFile(name, mutate) {
  const t = JSON.parse(readFileSync(VECTOR, 'utf8'))
  if (mutate) mutate(t)
  const f = join(tmp, name)
  writeFileSync(f, JSON.stringify(t))
  return f
}

// A counting HTTP server: any request to it counts as a network call.
function countingServer(handler) {
  const hits = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      hits.push(req.url)
      handler ? handler(req, res, body) : (res.writeHead(500), res.end('{}'))
    })
  })
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, hits, url: `http://127.0.0.1:${server.address().port}` })))
}

// A minimal JSON-RPC chain: one escrow whose metadataHash is `onChain`, listed by FACTORY.
function fakeChain(chainId, onChain) {
  const walletIface = new Interface(['function metadataHash() view returns (bytes32)', 'function factory() view returns (address)'])
  const factoryIface = new Interface(['function isEscrow(address) view returns (bool)'])
  const hex = (n) => '0x' + n.toString(16)
  const block = {
    hash: '0x' + '99'.repeat(32), parentHash: '0x' + '88'.repeat(32), number: hex(100), timestamp: hex(1800000000),
    nonce: '0x0000000000000000', difficulty: '0x0', gasLimit: hex(30000000), gasUsed: '0x0',
    miner: '0x' + '00'.repeat(20), extraData: '0x', baseFeePerGas: '0x1', transactions: [],
  }
  return countingServer((req, res, body) => {
    const { id, method, params } = JSON.parse(body)
    let result
    if (method === 'eth_chainId') result = hex(chainId)
    else if (method === 'eth_blockNumber') result = hex(100)
    else if (method === 'eth_getBlockByNumber') result = block
    else if (method === 'eth_getCode') result = params[0].toLowerCase() === ESCROW ? '0x6001' : '0x'
    else if (method === 'eth_call') {
      const { to, data } = params[0]
      if (to.toLowerCase() === FACTORY) result = factoryIface.encodeFunctionResult('isEscrow', [true])
      else if (data.startsWith(walletIface.getFunction('factory').selector)) result = walletIface.encodeFunctionResult('factory', [FACTORY])
      else result = walletIface.encodeFunctionResult('metadataHash', [onChain])
    } else result = null
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id, result }))
  })
}

test('the spec vector hashes to the value in expected.json', async () => {
  const r = await cli(['terms', 'hash', VECTOR])
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.stdout.trim(), EXPECTED)
  const j = await cli(['terms', 'hash', VECTOR, '--json'])
  assert.equal(JSON.parse(j.stdout).hash, EXPECTED)
})

test('incomplete terms: hash lists every problem and exits non-zero', async () => {
  const f = termsFile('no-test.json', (t) => { delete t.deliverables[0].acceptanceTest; delete t.deadline })
  const r = await cli(['terms', 'hash', f])
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /acceptanceTest/)
  assert.match(r.stderr, /deadline/)
  assert.equal(r.stdout.trim(), '')
})

test('create-job --terms refuses incomplete terms before any network call', async () => {
  const srv = await countingServer()
  try {
    const f = termsFile('incomplete.json', (t) => { delete t.deliverables[0].acceptanceTest })
    const r = await cli(['create-job', '--open', '--terms', f], { env: { PAKTSUITE_URL: srv.url } })
    assert.notEqual(r.code, 0)
    assert.match(r.stderr, /acceptanceTest/)
    assert.deepEqual(srv.hits, [], 'no request may reach the API')
    const resumed = await cli(['create-job', '--resume', 'job1', '--terms', f], { env: { PAKTSUITE_URL: srv.url } })
    assert.notEqual(resumed.code, 0)
    assert.match(resumed.stderr, /acceptanceTest/)
    assert.deepEqual(srv.hits, [], 'the resume path must not reach the API either')
    // control: complete terms get past the check and then do reach the network
    const ok = await cli(['create-job', '--open', '--terms', VECTOR], { env: { PAKTSUITE_URL: srv.url } })
    assert.match(ok.stderr, new RegExp(EXPECTED))
    assert.ok(srv.hits.length > 0, 'the control run must hit the API')
  } finally {
    srv.server.close()
  }
})

test('verify reports match for the funded terms and mismatch after a one-byte change', async () => {
  const chain = await fakeChain(43114, EXPECTED)
  try {
    const flags = ['--escrow', ESCROW, '--factory', FACTORY, '--rpc', chain.url]
    const m = await cli(['terms', 'verify', VECTOR, ...flags])
    assert.equal(m.code, 0, m.stderr)
    assert.match(m.stdout, /^MATCH/)
    const changed = termsFile('one-byte.json', (t) => { t.title = t.title + '!' })
    const x = await cli(['terms', 'verify', changed, ...flags])
    assert.notEqual(x.code, 0)
    assert.match(x.stdout, /^MISMATCH/)
  } finally {
    chain.server.close()
  }
})

test('sign then verify the signature; a one-byte change makes it invalid', async () => {
  const chain = await fakeChain(43114, EXPECTED)
  try {
    const s = await cli(['terms', 'sign', VECTOR, '--escrow', ESCROW])
    assert.equal(s.code, 0, s.stderr)
    const signature = s.stdout.trim()
    assert.match(signature, /^0x[0-9a-f]{130}$/)
    assert.ok(!(s.stdout + s.stderr).includes(KEY.slice(2)), 'key material must never be printed')
    const flags = ['--escrow', ESCROW, '--factory', FACTORY, '--rpc', chain.url, '--signer', new Wallet(KEY).address, '--signature', signature]
    const good = await cli(['terms', 'verify', VECTOR, ...flags])
    assert.equal(good.code, 0, good.stderr)
    assert.match(good.stdout, /SIGNATURE OK/)
    const changed = termsFile('sig-changed.json', (t) => { t.description = t.description + '.' })
    const bad = await cli(['terms', 'verify', changed, ...flags])
    assert.notEqual(bad.code, 0)
    assert.match(bad.stdout, /SIGNATURE INVALID/)
  } finally {
    chain.server.close()
  }
})

test('a malformed private key is never echoed', async () => {
  const bad = 'not-a-hex-key-SENTINEL123'
  const r = await cli(['terms', 'sign', VECTOR, '--escrow', ESCROW], { env: { AGENT_PRIVATE_KEY: bad } })
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /AGENT_PRIVATE_KEY is not a valid private key/)
  assert.ok(!(r.stdout + r.stderr).includes('SENTINEL123'))
})

test('verify refuses an RPC that serves another chain than the terms', async () => {
  const chain = await fakeChain(1, EXPECTED)
  try {
    const r = await cli(['terms', 'verify', VECTOR, '--escrow', ESCROW, '--factory', FACTORY, '--rpc', chain.url])
    assert.notEqual(r.code, 0)
    assert.ok(!/MATCH/.test(r.stdout))
    assert.match(r.stderr, /serves chain 1/)
  } finally {
    chain.server.close()
  }
})

test('create-job --terms refuses flags that disagree with the terms, before any network call', async () => {
  const srv = await countingServer()
  try {
    for (const flags of [['--title', 'Something else'], ['--amount', '999'], ['--deliverable', 'another thing'], ['--description', 'other text']]) {
      const r = await cli(['create-job', '--open', '--terms', VECTOR, ...flags], { env: { PAKTSUITE_URL: srv.url } })
      assert.equal(r.code, 2, flags.join(' '))
      assert.match(r.stderr, /differs from the terms/)
    }
    assert.deepEqual(srv.hits, [])
  } finally {
    srv.server.close()
  }
})
