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
  const result = sdkOk(await sdk.job.cancelInvite(jobId, inviteeId), 'job.cancelInvite')
  // A platform-created escrow can't be re-pointed to a new invitee, so the API cancels the job
  // and refunds the deposit at once (autoCancelled) instead of leaving it bound to the old one.
  const autoCancelled = Boolean(result?.autoCancelled)
  const refundTxHash = result?.refundTxHash ?? null
  const refundPending = Boolean(result?.refundPending)
  if (config.json)
    return out({
      ok: true,
      jobId,
      inviteeId,
      status: 'cancelled',
      autoCancelled,
      ...(autoCancelled ? { jobStatus: result?.job?.status ?? 'cancelled', refundTxHash, refundPending } : {}),
    })
  print(`Revoked the invitation of ${inviteeId} to job ${jobId}.`)
  if (autoCancelled) {
    print(`Job cancelled — the escrow could not be re-pointed, so the deposit is refunded. Job status: ${result?.job?.status ?? 'cancelled'}`)
    if (refundTxHash) print(`Refund tx:  ${refundTxHash}`)
    else if (refundPending) print('Refund:     pending — the server will retry the on-chain refund; check `psilocli job`')
    return
  }
  note('Invite someone else with: psilocli create-job --resume <jobId> --invite-id <userId>.')
}
