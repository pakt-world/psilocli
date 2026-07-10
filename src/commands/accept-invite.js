import { parseCommand, resolveConfig } from '../config.js'
import { cliInit, sdkOk } from '../client.js'
import { signAndBroadcast } from '../chains.js'
import { out, print, fail } from '../output.js'

export const usage = 'psilocli accept-invite <jobId> <inviteId>'

export async function run(argv) {
  const { values, positionals } = parseCommand(argv, {}, { positionals: true })
  const [jobId, inviteId] = positionals
  if (!jobId || !inviteId) fail(`Usage: ${usage}`, 2)

  const config = resolveConfig(values)
  const { sdk } = await cliInit(config)
  const acceptData = sdkOk(
    await sdk.job.acceptInvite(jobId, inviteId),
    'acceptInvite',
  )
  let txHash = null
  if (acceptData?.acceptPayload) {
    txHash = await signAndBroadcast(config.key, acceptData.acceptPayload)
    sdkOk(
      await sdk.job.confirmTx(jobId, { step: 'onAccept', txHash }),
      'confirmTx onAccept',
    )
  }
  if (config.json) out({ ok: true, jobId, inviteId, txHash })
  else
    print(
      txHash
        ? `Accepted invite ${inviteId} — txHash: ${txHash}`
        : `Accepted invite ${inviteId} (off-chain)`,
    )
}
