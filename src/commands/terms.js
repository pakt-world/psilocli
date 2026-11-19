import { readFileSync } from 'node:fs'
import { ethers } from 'ethers'
import { parseCommand } from '../config.js'
import { out, print, note, fail } from '../output.js'
import { connectProvider, fetchAvailableChains, resolveRpc, withRpcTimeout } from '../chains.js'

export const usage =
  'psilocli terms hash <file> [--json]                      Validate Job Terms v1 and print its hash\n' +
  'psilocli terms sign <file> --escrow <0x>                 Sign the terms for one escrow with your wallet\n' +
  'psilocli terms verify <file> --escrow <0x>               Check the escrow holds these terms (and a signature)\n' +
  '                      [--signature <0x> --signer <0x>] [--block <n>] [--factory <0x>] [--rpc <url>]'

// The terms functions arrive with @pakt/psilo 0.4.0. They are loaded only when a terms code path runs, so
// every other command keeps working on an older SDK.
async function termsSdk() {
  const sdk = await import('@pakt/psilo')
  if (typeof sdk.hashJobTerms !== 'function')
    fail('Job Terms commands need @pakt/psilo 0.4.0 or newer; upgrade it (npm install @pakt/psilo@^0.4.0)', 1)
  return sdk
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/

// Reads a terms file and validates it as Job Terms v1. Incomplete terms are refused with every
// problem listed; nothing else happens before this passes. The file is passed to the SDK as text
// (the strict path), so what is hashed is exactly what is on disk.
export async function loadTerms(file) {
  const { hashJobTerms, canonicalizeJobTerms, parseJobTerms, JobTermsError } = await termsSdk()
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    fail(`cannot read terms file ${file}: ${err.message}`, 2)
  }
  try {
    const canonical = canonicalizeJobTerms(text)
    const hash = hashJobTerms(text)
    return { text, canonical, hash, terms: parseJobTerms(canonical) }
  } catch (err) {
    if (err instanceof JobTermsError) {
      note(`Job Terms v1 refused: ${err.problems.length} problem${err.problems.length === 1 ? '' : 's'}`)
      for (const p of err.problems) note(`  - ${p}`)
      process.exit(1)
    }
    fail(err.message, 1)
  }
}

function needEscrow(values) {
  if (!values.escrow || !ADDRESS.test(values.escrow)) fail('--escrow <0x address> is required', 2)
  return values.escrow
}

async function hash(argv) {
  const { values, positionals } = parseCommand(argv, {}, { positionals: true })
  if (!positionals[0]) fail(`usage: psilocli terms hash <file>`, 2)
  const { hash: h } = await loadTerms(positionals[0])
  const { checkJobTermsRuntime } = await termsSdk()
  if (values.json) out({ ok: true, hash: h, runtime: checkJobTermsRuntime() })
  else print(h)
}

async function sign(argv) {
  const { values, positionals } = parseCommand(argv, { escrow: { type: 'string' } }, { positionals: true })
  if (!positionals[0]) fail('usage: psilocli terms sign <file> --escrow <0x>', 2)
  const escrow = needEscrow(values)
  const key = values.key ?? process.env.AGENT_PRIVATE_KEY
  if (!key) fail('--key / AGENT_PRIVATE_KEY is required')
  if (values.key)
    note('Warning: --key on the command line is visible in shell history and process lists; prefer AGENT_PRIVATE_KEY')
  const { text, hash: h, terms } = await loadTerms(positionals[0])
  const { signJobTerms } = await termsSdk()
  // Never let an error carry the key: ethers echoes a malformed key value in its messages.
  let wallet
  try {
    wallet = new ethers.Wallet(key)
  } catch {
    fail('AGENT_PRIVATE_KEY is not a valid private key', 1)
  }
  // Preview: what the wallet is about to commit to.
  note(`Signing "${terms.title}" for escrow ${escrow}`)
  note(`  price ${terms.price.amount} (decimals ${terms.price.decimals}) of ${terms.price.token} on chain ${terms.price.chainId}`)
  note(`  deadline ${terms.deadline} (${new Date(terms.deadline * 1000).toISOString()})`)
  note(`  terms hash ${h}`)
  note(`  signer ${wallet.address}`)
  let signature
  try {
    signature = await signJobTerms(text, wallet, escrow)
  } catch {
    fail('signing failed (the key and the terms were not printed)', 1)
  }
  if (values.json) out({ ok: true, hash: h, escrow, signer: wallet.address, signature })
  else print(signature)
}

// RPC and factory: explicit flags win; otherwise the server's chain list (public, no login).
async function locateChain(values, chainId) {
  let url = values.rpc
  let factory = values.factory ?? process.env.PSILO_FACTORY
  if (!url || !factory) {
    const { PsiloSDK } = await termsSdk()
    const { DEFAULT_URL } = await import('../config.js')
    const sdk = await PsiloSDK.init({ baseUrl: values.url ?? process.env.PAKTSUITE_URL ?? DEFAULT_URL })
    if (!url) url = (await resolveRpc(sdk, chainId)).url
    if (!factory) {
      const chain = (await fetchAvailableChains(sdk)).find((c) => String(c.chainId) === String(chainId))
      factory = chain?.factoryAddress
    }
  }
  if (!factory || !ADDRESS.test(factory))
    fail(`no escrow factory known for chain ${chainId}; pass --factory <0x> (or PSILO_FACTORY)`, 2)
  return { url, factory }
}

async function verify(argv) {
  const { values, positionals } = parseCommand(
    argv,
    {
      escrow: { type: 'string' },
      signature: { type: 'string' },
      signer: { type: 'string' },
      block: { type: 'string' },
      factory: { type: 'string' },
      rpc: { type: 'string' },
    },
    { positionals: true },
  )
  if (!positionals[0]) fail('usage: psilocli terms verify <file> --escrow <0x>', 2)
  const escrow = needEscrow(values)
  if (Boolean(values.signature) !== Boolean(values.signer)) fail('--signature and --signer go together', 2)
  if (values.signer && !ADDRESS.test(values.signer)) fail('--signer must be a 0x address', 2)
  if (values.block != null && !/^\d+$/.test(values.block)) fail('--block must be a block number', 2)
  const { text, hash: h, terms } = await loadTerms(positionals[0])
  const { verifyJobTermsSignature, attestEscrowTerms } = await termsSdk()
  const chainId = terms.price.chainId
  const { url, factory } = await locateChain(values, chainId)
  const provider = await connectProvider(url, chainId)
  let failed = false
  try {
    // The provider is pinned to the terms' chain, so ask the node itself which chain it serves.
    const served = BigInt(await withRpcTimeout(provider.send('eth_chainId', []), url))
    if (served !== BigInt(chainId))
      fail(`the RPC serves chain ${served}, but the terms are for chain ${chainId}; pass the right --rpc`, 1)
    const blockNumber = values.block != null ? Number(values.block) : await provider.getBlockNumber()
    const result = { ok: true, hash: h, escrow, chainId, blockNumber }
    let attestation
    try {
      attestation = await attestEscrowTerms({ provider, escrow, blockNumber, terms: text, factory })
    } catch (err) {
      fail(`cannot attest the escrow: ${err.message}`, 1)
    }
    result.attestation = attestation.attestation
    result.attestationKeccak256 = attestation.attestationKeccak256
    result.termsMatch = attestation.attestation.match
    if (values.signature) {
      const sig = await verifyJobTermsSignature({
        provider, chainId, escrow, terms: text, signer: values.signer, signature: values.signature,
      })
      result.signatureOk = sig.ok
      result.signatureMethod = sig.method
    }
    result.ok = result.termsMatch && result.signatureOk !== false
    if (values.json) out(result)
    else {
      print(
        result.termsMatch
          ? `MATCH: escrow ${escrow} holds these terms (${h}) at block ${blockNumber}`
          : `MISMATCH: escrow ${escrow} holds ${attestation.attestation.onChainMetadataHash} but these terms hash to ${h} (block ${blockNumber}); no court will hear it`,
      )
      if (values.signature)
        print(
          result.signatureOk
            ? `SIGNATURE OK: ${values.signer} signed these terms for this escrow (${result.signatureMethod})`
            : `SIGNATURE INVALID: ${values.signer} did not sign these terms for this escrow`,
        )
    }
    failed = !result.ok
  } finally {
    provider.destroy()
  }
  // The entry point resets exitCode after run(), so exit explicitly once stdout has flushed.
  if (failed) await new Promise((resolve) => process.stdout.write('', resolve)).then(() => process.exit(1))
}

export async function run(argv) {
  const [sub, ...rest] = argv
  if (sub === 'hash') return hash(rest)
  if (sub === 'sign') return sign(rest)
  if (sub === 'verify') return verify(rest)
  fail(`usage:\n${usage}`, 2)
}
