import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sha256Hex, voteCommitment } from '@pakt/psilo'
import { castVote, disputedHint, partyRole, raiseDisputePayload, voteStore } from '../src/issues.js'

const ok = (data) => ({ status: 'success', data })
const err = (message) => ({ status: 'error', data: null, message: [message] })

// A stub of sdk.issue that checks commitments the way the server does.
function stubSdk({ commit, reveal } = {}) {
  const calls = []
  let stored = null
  const issue = {
    juryCommit: async (id, commitment) => {
      calls.push(['commit', id])
      if (commit) return commit(commitment)
      if (stored) return err('Already committed')
      stored = commitment
      return ok({ committed: true })
    },
    juryReveal: async (id, dto) => {
      calls.push(['reveal', id])
      if (reveal) return reveal(dto)
      const match = voteCommitment(dto.verdict, dto.rationaleHash, dto.jurorSalt) === stored &&
        sha256Hex(dto.rationale) === dto.rationaleHash
      return match ? ok({ revealed: true, onTime: true, issueStatus: 'resolved' }) : err('Reveal does not match the stored commitment')
    },
  }
  return { sdk: { issue }, calls, get stored() { return stored } }
}

const tmpStore = () => voteStore(mkdtempSync(join(tmpdir(), 'psilocli-jury-')))

test('castVote commits, reveals, and removes the saved vote', async () => {
  const store = tmpStore()
  const t = stubSdk()
  const res = await castVote(t.sdk, 'i1', { verdict: 'defense', rationale: 'delivered in full' }, store)
  assert.deepEqual(res, { revealed: true, onTime: true, issueStatus: 'resolved' })
  assert.deepEqual(t.calls.map((c) => c[0]), ['commit', 'reveal'])
  assert.equal(store.load('i1'), null)
})

test('the vote file is saved before the commit, mode 600', async () => {
  const store = tmpStore()
  let seen = null
  const t = stubSdk({
    commit: () => {
      seen = store.load('i1')
      return ok({ committed: true })
    },
    reveal: () => err('socket hang up'),
  })
  await assert.rejects(castVote(t.sdk, 'i1', { verdict: 'plaintiff', rationale: 'r' }, store), /retry with --resume/)
  assert.equal(seen.verdict, 'plaintiff')
  assert.match(seen.jurorSalt, /^[0-9a-f]{64}$/)
  assert.equal(statSync(store.path('i1')).mode & 0o777, 0o600)
  assert.ok(store.load('i1').committedAt)
})

test('a crash after the commit resumes with the saved salt and does not re-commit', async () => {
  const store = tmpStore()
  const t = stubSdk()
  let failReveal = true
  const flaky = {
    issue: {
      juryCommit: t.sdk.issue.juryCommit,
      juryReveal: async (id, dto) => (failReveal ? ((failReveal = false), err('ETIMEDOUT')) : t.sdk.issue.juryReveal(id, dto)),
    },
  }
  await assert.rejects(castVote(flaky, 'i1', { verdict: 'defense', rationale: 'r' }, store))
  const res = await castVote(flaky, 'i1', { resume: true }, store)
  assert.equal(res.revealed, true)
  assert.deepEqual(t.calls.map((c) => c[0]), ['commit', 'reveal'])
  assert.equal(store.load('i1'), null)
})

test('"Already committed" with a saved vote is the resume path, not an error', async () => {
  const store = tmpStore()
  const t = stubSdk()
  await assert.rejects(
    castVote({ issue: { ...t.sdk.issue, juryReveal: async () => err('ETIMEDOUT') } }, 'i1', { verdict: 'defense', rationale: 'r' }, store),
  )
  const vote = store.load('i1')
  delete vote.committedAt // a crash between the commit landing and the file update
  store.save(vote)
  const res = await castVote(t.sdk, 'i1', { verdict: 'defense', rationale: 'r' }, store)
  assert.equal(res.revealed, true)
})

test('a mismatched reveal is reported once and never retried', async () => {
  const store = tmpStore()
  const t = stubSdk({ reveal: () => err('Reveal does not match the stored commitment') })
  await assert.rejects(castVote(t.sdk, 'i1', { verdict: 'defense', rationale: 'r' }, store), /seat was replaced and is unpaid/)
  assert.equal(store.load('i1'), null)
  assert.deepEqual(t.calls.map((c) => c[0]), ['commit', 'reveal'])
})

test('a different vote cannot overwrite a saved one', async () => {
  const store = tmpStore()
  const t = stubSdk({ reveal: () => err('ETIMEDOUT') })
  await assert.rejects(castVote(t.sdk, 'i1', { verdict: 'defense', rationale: 'r' }, store))
  await assert.rejects(castVote(t.sdk, 'i1', { verdict: 'plaintiff', rationale: 'r' }, store), /cannot be changed/)
})

test('--resume with nothing saved fails clearly', async () => {
  await assert.rejects(castVote(stubSdk().sdk, 'i9', { resume: true }, tmpStore()), /nothing to resume/)
})

test('partyRole: creator is the buyer; owner is the seller only once accepted', () => {
  const job = { creator: { _id: 'b' }, owner: 's', escrowInvitationAccepted: false }
  assert.equal(partyRole(job, 'b'), 'buyer')
  assert.equal(partyRole(job, 's'), null)
  assert.equal(partyRole({ ...job, escrowInvitationAccepted: true }, 's'), 'seller')
  assert.equal(partyRole(job, 'x'), null)
})

test('disputedHint names the issue only on a disputed job', () => {
  assert.equal(disputedHint({ status: 'ongoing', issue: 'i1' }), '')
  assert.match(disputedHint({ status: 'disputed', issue: { _id: 'i1' } }), /issue i1: psilocli issue show i1/)
})

test('raiseDisputePayload matches the API payload (raiseDispute() selector)', () => {
  const p = raiseDisputePayload('0x7ffDd73f02b4006373e1bD8B76e4e64c88f397Fe', '84532')
  assert.equal(p.data, '0x6daa2d44')
  assert.equal(p.chainId, '84532')
})
