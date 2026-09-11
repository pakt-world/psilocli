import { parseCommand, resolveConfig } from '../config.js'
import { cliInit, sdkOk } from '../client.js'
import { out, print, note, fail } from '../output.js'
import { describeRefund } from '../refund.js'

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

  const pending = sdkOk(await sdk.job.getCancelRequest(jobId), 'job.getCancelRequest')
  const cr0 = pending?.cancelRequest
  if (!cr0 || cr0.status !== 'pending')
    fail(
      cr0
        ? `The latest cancel request on job ${jobId} is ${cr0.status}; nothing pending to decline.`
        : `No cancel request on job ${jobId}.`,
    )
  const preview = describeRefund(pending?.refund)
  if (preview) note(`Declining — accepting would have ${preview}`)

  const result = sdkOk(
    await sdk.job.declineCancel(
      jobId,
      values.resolution ? { resolution: values.resolution } : undefined,
    ),
    'job.declineCancel',
  )
  const cr = result?.cancelRequest
  if (config.json) {
    out({
      ok: true,
      cancelRequestId: cr?._id,
      jobStatus: result?.job?.status,
      refund: result?.refund ?? pending?.refund ?? null,
    })
  } else {
    print(`Cancel declined — job continues (status: ${result?.job?.status ?? '—'})`)
    if (cr?.resolution) print(`Resolution: ${cr.resolution}`)
  }
}
