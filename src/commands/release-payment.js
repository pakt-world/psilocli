import { parseArgs } from 'node:util'
import { sdkOk } from '../client.js'
import { signAndBroadcast } from '../chains.js'
import { out, fail } from '../output.js'

export async function cmdReleasePayment(config, { sdk }, args) {
  const { positionals } = parseArgs({
    args,
    options: {},
    allowPositionals: true,
    strict: true,
  })

  const jobId = positionals[0]
  if (!jobId) fail('Usage: psilocli release-payment <jobId>', 2)

  const releaseData = sdkOk(await sdk.job.releasePayment(jobId), 'releasePayment')
  const releasePayload = releaseData?.releasePayload
  if (!releasePayload)
    fail('No releasePayload returned — job may not be in review status')

  // signAndBroadcast calls tx.wait() for one-block confirmation — no sleep needed.
  const txHash = await signAndBroadcast(releasePayload, config.key)
  sdkOk(
    await sdk.job.confirmTx(jobId, { step: 'onRelease', txHash }),
    'confirmTx onRelease',
  )

  if (config.json) out({ ok: true, jobId, txHash })
  else process.stdout.write(`Payment released — txHash: ${txHash}\n`)
}
