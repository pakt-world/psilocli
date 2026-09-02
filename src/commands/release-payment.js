import { parseCommand, resolveConfig } from '../config.js'
import { cliInit, sdkOk } from '../client.js'
import { signAndBroadcast } from '../chains.js'
import { sleep } from '../messaging.js'
import { out, print, fail } from '../output.js'

export const usage = 'psilocli release-payment <jobId> [--rpc <url>]'

export async function run(argv) {
  const { values, positionals } = parseCommand(argv, { rpc: { type: 'string' } }, { positionals: true })
  const jobId = positionals[0]
  if (!jobId) fail(`Usage: ${usage}`, 2)

  const config = resolveConfig(values)
  const { sdk } = await cliInit(config)
  const releaseData = sdkOk(await sdk.job.releasePayment(jobId), 'releasePayment')
  const releasePayload = releaseData?.releasePayload
  if (!releasePayload)
    fail('No releasePayload returned — job may not be in review status')
  const txHash = await signAndBroadcast(sdk, config.key, releasePayload, values.rpc ?? null)
  await sleep(8_000)
  sdkOk(
    await sdk.job.confirmTx(jobId, { step: 'onRelease', txHash }),
    'confirmTx onRelease',
  )
  if (config.json) out({ ok: true, jobId, txHash })
  else print(`Payment released — txHash: ${txHash}`)
}
