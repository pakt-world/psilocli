import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ethers } from 'ethers'
import { newJurorSalt, sha256Hex, voteCommitment } from '@pakt/psilo'
import { resolveRpcUrl } from './chains.js'
import { cliInit } from './client.js'

// Shared by the issue, jury and rewards commands: signed SDK session, text inputs, token
// formatting, the local vote store, and the escrow reads a dispute needs.

export const VERDICTS = ['plaintiff', 'defense']

// Issue-resolution writes are signed with the agent's wallet on top of the JWT.
export async function cliInitSigned(config) {
  const session = await cliInit(config)
  session.sdk.issue.useSigner(config.key)
  return session
}

// --content <text> or --content-file <path>; '-' reads stdin. Returns '' when neither is set.
export function readText(values, flag, fileFlag) {
  if (values[flag] === '-' || values[fileFlag] === '-') return readFileSync(0, 'utf8').trim()
  if (values[flag]) return String(values[flag]).trim()
  if (values[fileFlag]) return readFileSync(values[fileFlag], 'utf8').trim()
  return ''
}

const idOf = (v) => String(v?._id ?? v ?? '')

// Appended to a refusal on a disputed job, so the caller knows which issue froze it.
export function disputedHint(job) {
  if (job?.status !== 'disputed' || !job.issue) return ''
  return ` Its escrow is frozen by issue ${idOf(job.issue)}: psilocli issue show ${idOf(job.issue)}`
}

// creator is the buyer; owner is the seller once the invite was accepted on chain.
export function partyRole(job, userId) {
  if (idOf(job.creator) === userId) return 'buyer'
  if (job.escrowInvitationAccepted && idOf(job.owner) === userId) return 'seller'
  return null
}

// Symbol and decimals of the token a job's escrow holds, read from the token itself.
export async function tokenMeta(sdk, job) {
  const chainId = job.escrowChainId ?? job.chainId
  if (!job.asset) return { symbol: 'native', decimals: 18 }
  try {
    const provider = new ethers.JsonRpcProvider(await resolveRpcUrl(sdk, chainId))
    const erc20 = new ethers.Contract(
      job.asset,
      ['function symbol() view returns (string)', 'function decimals() view returns (uint8)'],
      provider,
    )
    const [symbol, decimals] = await Promise.all([erc20.symbol(), erc20.decimals()])
    return { symbol, decimals: Number(decimals) }
  } catch {
    return { symbol: '', decimals: null }
  }
}

// Base units → "9.5 USDC". Without decimals the raw base units are shown, labelled as such.
export function fmtUnits(value, meta) {
  if (value === undefined || value === null || value === '') return '—'
  if (meta?.decimals == null) return `${value} (base units)`
  const n = ethers.formatUnits(BigInt(value), meta.decimals).replace(/\.0$/, '')
  return `${n} ${meta.symbol}`.trim()
}

// ── escrow reads ────────────────────────────────────────────────────────────

const ESCROW_ABI = ['function disputed() view returns (bool)', 'function raiseDispute()']

export async function escrowDisputed(sdk, escrowAddress, chainId) {
  const provider = new ethers.JsonRpcProvider(await resolveRpcUrl(sdk, chainId))
  return new ethers.Contract(escrowAddress, ESCROW_ABI, provider).disputed()
}

// The same payload the API returns from POST /v1/job-issues: raiseDispute() on the escrow.
// Built locally so a crashed `issue open` can be resumed without asking the server again.
export function raiseDisputePayload(escrowAddress, chainId) {
  return {
    to: escrowAddress,
    data: new ethers.Interface(ESCROW_ABI).encodeFunctionData('raiseDispute'),
    value: '0',
    chainId: String(chainId),
  }
}

// ── local vote store ─────────────────────────────────────────────────────────
// A committed vote can only be revealed with its salt. Losing it after the commit gets the
// seat replaced and unpaid, so it is written (mode 600) before committing and removed only
// once the reveal lands. It lives next to WALLET.md: one agent identity, one state dir.

export function voteStore(baseDir = process.cwd()) {
  const dir = join(baseDir, '.psilocli', 'jury')
  const file = (issueId) => join(dir, `${issueId}.json`)
  return {
    path: file,
    load(issueId) {
      return existsSync(file(issueId)) ? JSON.parse(readFileSync(file(issueId), 'utf8')) : null
    },
    save(vote) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeFileSync(file(vote.issueId), JSON.stringify(vote, null, 2), { mode: 0o600 })
      chmodSync(file(vote.issueId), 0o600)
    },
    remove(issueId) {
      rmSync(file(issueId), { force: true })
    },
  }
}

const messageOf = (res) => (Array.isArray(res?.message) ? res.message.join('; ') : String(res?.message ?? ''))
const isError = (res) => !res || res.status === 'error'

/**
 * `jury vote`: commit then reveal, resumable. Steps:
 *   1. a saved vote for this issue wins over new flags (a commit may already be on record);
 *   2. otherwise build {verdict, rationale, rationaleHash, jurorSalt} and save it first;
 *   3. commit — "Already committed" with a saved vote is the resume case, not an error;
 *   4. reveal — a hash mismatch replaced the seat server-side: report it, never retry;
 *      any other failure keeps the vote file so `jury vote <id> --resume` can try again;
 *   5. on success remove the vote file.
 * Returns the reveal result; throws with a message fit for the user otherwise.
 */
export async function castVote(sdk, issueId, { verdict, rationale, resume = false }, store, log = () => {}) {
  let vote = store.load(issueId)
  if (resume && !vote) {
    throw new Error(`No saved vote for issue ${issueId} at ${store.path(issueId)}; nothing to resume.`)
  }
  if (vote && !resume && (vote.verdict !== verdict || vote.rationale !== rationale)) {
    throw new Error(
      `A different vote for issue ${issueId} is saved at ${store.path(issueId)} and may already be committed. ` +
        'Run `psilocli jury vote <issueId> --resume` to finish it; a committed vote cannot be changed.',
    )
  }
  if (!vote) {
    const rationaleHash = sha256Hex(rationale)
    vote = { issueId, verdict, rationale, rationaleHash, jurorSalt: newJurorSalt(), createdAt: new Date().toISOString() }
    store.save(vote)
  }

  if (!vote.committedAt) {
    const commitment = voteCommitment(vote.verdict, vote.rationaleHash, vote.jurorSalt)
    const res = await sdk.issue.juryCommit(issueId, commitment)
    if (isError(res) && !/already committed/i.test(messageOf(res))) {
      throw new Error(`jury commit failed: ${messageOf(res)}`)
    }
    vote.committedAt = new Date().toISOString()
    store.save(vote)
    log(`Committed vote on issue ${issueId}`)
  }

  const res = await sdk.issue.juryReveal(issueId, {
    verdict: vote.verdict,
    rationaleHash: vote.rationaleHash,
    jurorSalt: vote.jurorSalt,
    rationale: vote.rationale,
  })
  if (isError(res)) {
    const msg = messageOf(res)
    if (/does not match/i.test(msg)) {
      store.remove(issueId)
      throw new Error(
        `Reveal rejected: it does not match the commitment on record. The seat was replaced and is unpaid. (${msg})`,
      )
    }
    if (/already revealed/i.test(msg)) {
      store.remove(issueId)
      return { revealed: true, alreadyRevealed: true }
    }
    throw new Error(`jury reveal failed: ${msg}. The vote is kept at ${store.path(issueId)}; retry with --resume.`)
  }
  store.remove(issueId)
  return res.data
}
