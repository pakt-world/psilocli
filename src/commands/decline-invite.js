import { parseArgs } from 'node:util'
import { out, fail } from '../output.js'

export async function cmdDeclineInvite(config, { sdk }, args) {
  const { positionals } = parseArgs({
    args,
    options: {},
    allowPositionals: true,
    strict: true,
  })

  const [jobId, inviteId] = positionals
  if (!jobId || !inviteId)
    fail('Usage: psilocli decline-invite <jobId> <inviteId>', 2)

  await sdk.job.declineInvite(jobId, inviteId)

  if (config.json) out({ ok: true, jobId, inviteId })
  else process.stdout.write(`Declined invite ${inviteId}\n`)
}
