import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resumeJob } from '../src/commands/create-job.js'

const ok = (data) => ({ status: 'success', data })
const err = (message) => ({ status: 'error', data: null, message: [message] })

// sdk.job / sdk.user stubs for a job whose deposit landed on chain but was never validated
// (the process was killed between the deposit tx and validatePayment).
function stubSdk({ invite } = {}) {
  const calls = []
  let escrowPaid = false
  const job = {
    getById: async (id) => (calls.push('getById'), ok({ _id: id, title: 't', status: 'open', escrowPaid })),
    getEscrowStatus: async () => (calls.push('getEscrowStatus'), ok({ onChain: { deposited: true } })),
    makeDeposit: async () => {
      throw new Error('must not deposit again')
    },
    validatePayment: async (id, retry) => {
      calls.push('validatePayment')
      assert.equal(typeof retry?.onRetry, 'function')
      escrowPaid = true
      return ok({ validated: true })
    },
    inviteTalent: async () => {
      calls.push('inviteTalent')
      if (invite) return invite()
      return escrowPaid ? ok({ job: {} }) : err('Escrow has not been funded yet. Please fund the escrow before inviting.')
    },
    getInvites: async () => (calls.push('getInvites'), ok([{ inviteeId: 'u2', status: 'pending', createdAt: '2026-11-07T00:00:00Z' }])),
    confirmTx: async () => (calls.push('confirmTx'), ok({})),
  }
  const user = { getUserById: async (id) => ok({ _id: id }) }
  return { sdk: { job, user }, calls }
}

test('resume validates a landed deposit before inviting', async () => {
  const t = stubSdk()
  const res = await resumeJob(t.sdk, { key: '0x' }, 'j1', null, null, 'u2')
  assert.deepEqual(res, { jobId: 'j1', resumed: true })
  assert.ok(t.calls.indexOf('validatePayment') < t.calls.indexOf('inviteTalent'))
  assert.ok(!t.calls.includes('confirmTx'))
})

test('resume treats "already been invited" as success and reports the invite', async () => {
  const t = stubSdk({ invite: () => err('Talent has already been invited to this job') })
  const res = await resumeJob(t.sdk, { key: '0x' }, 'j1', null, null, 'u2')
  assert.equal(res.alreadyInvited, true)
  assert.equal(res.inviteStatus, 'pending')
  assert.ok(t.calls.includes('getInvites'))
})

test('resume still surfaces other invite errors', async () => {
  const t = stubSdk({ invite: () => err('Invitee user not found') })
  await assert.rejects(resumeJob(t.sdk, { key: '0x' }, 'j1', null, null, 'u2'), /Invitee user not found/)
})
