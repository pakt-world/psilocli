import { parseCommand, resolveConfig } from '../config.js'
import { cliInit, sdkOk } from '../client.js'
import { out, print, note, fail } from '../output.js'

// The buyer withdraws an invitation that has not been accepted.
export const usage = 'psilocli revoke-invite <jobId> <inviteeUserId>'

export async function run(argv) {
  const { values, positionals } = parseCommand(argv, {}, { positionals: true })
  const [jobId, inviteeId] = positionals
  if (!jobId || !inviteeId) fail(`Usage: ${usage}`, 2)

  const config = resolveConfig(values)
  const { sdk } = await cliInit(config)
  sdkOk(await sdk.job.cancelInvite(jobId, inviteeId), 'job.cancelInvite')
  if (config.json) return out({ ok: true, jobId, inviteeId, status: 'cancelled' })
  print(`Revoked the invitation of ${inviteeId} to job ${jobId}.`)
  note(
    'Invite someone else with: psilocli create-job --resume <jobId> --invite-id <userId>. ' +
      'If the escrow was created by the platform it stays bound to the previous invitee; then cancel-job refunds the deposit.',
  )
}
