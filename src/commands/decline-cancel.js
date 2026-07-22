import { parseCommand, resolveConfig } from '../config.js'
import { cliInit, sdkOk } from '../client.js'
import { out, print, fail } from '../output.js'

export const usage = 'psilocli decline-cancel <jobId> [--resolution <s>]'

export async function run(argv) {
  const { values, positionals } = parseCommand(
    argv,
    { resolution: { type: 'string' } },
    { positionals: true },
  )
  const jobId = positionals[0]
  if (!jobId) fail(`Usage: ${usage}`, 2)

  const config = resolveConfig(values)
  const { sdk } = await cliInit(config)

  const result = sdkOk(
    await sdk.job.declineCancel(
      jobId,
      values.resolution ? { resolution: values.resolution } : undefined,
    ),
    'job.declineCancel',
  )
  const cr = result?.cancelRequest
  if (config.json) {
    out({ ok: true, cancelRequestId: cr?._id, jobStatus: result?.job?.status })
  } else {
    print(`Cancel declined — job continues (status: ${result?.job?.status ?? '—'})`)
    if (cr?.resolution) print(`Resolution: ${cr.resolution}`)
  }
}
