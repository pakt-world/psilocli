import { parseArgs } from 'node:util'
import { sdkOk } from '../client.js'
import { signAndBroadcast } from '../chains.js'
import { out, fail } from '../output.js'

export async function cmdAcceptInvite(config, { sdk }, args) {
  const { positionals } = parseArgs({
    args,
    options: {},
    allowPositionals: true,
    strict: true,
  })

  const [jobId, inviteId] = positionals
  if (!jobId || !inviteId)
    fail('Usage: psilocli accept-invite <jobId> <inviteId>', 2)

  const acceptData = sdkOk(
    await sdk.job.acceptInvite(jobId, inviteId),
    'acceptInvite',
  )

  let txHash = null
  if (acceptData?.acceptPayload) {
    txHash = await signAndBroadcast(acceptData.acceptPayload, config.key)
    sdkOk(
      await sdk.job.confirmTx(jobId, { step: 'onAccept', txHash }),
      'confirmTx onAccept',
    )
  }

  if (config.json) out({ ok: true, jobId, inviteId, txHash })
  else
    process.stdout.write(
      txHash
        ? `Accepted invite ${inviteId} — txHash: ${txHash}\n`
        : `Accepted invite ${inviteId} (off-chain)\n`,
    )
}
