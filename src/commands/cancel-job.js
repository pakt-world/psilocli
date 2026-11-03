import { parseCommand, resolveConfig } from '../config.js'
import { cliInit, sdkOk } from '../client.js'
import { out, print, note, fail } from '../output.js'
import { describeRefund } from '../refund.js'

export const usage =
  'psilocli cancel-job <jobId> --reason <s> [--explanation <s>]'

export async function run(argv) {
  const { values, positionals } = parseCommand(
    argv,
    {
      reason:      { type: 'string' },
      explanation: { type: 'string' },
    },
    { positionals: true },
  )
  const jobId = positionals[0]
  if (!jobId)        fail(`Usage: ${usage}`, 2)
  if (!values.reason) fail('--reason is required', 2)

  const config = resolveConfig(values)
  const { sdk } = await cliInit(config)

  // Pre-flight: reject if a cancel request already exists. Exception: on an `open` job no seller
  // has accepted, so there is nobody to resolve it; the server cancels and refunds at once,
  // including over a request left pending before it did.
  const existing = sdkOk(
    await sdk.job.getCancelRequest(jobId),
    'job.getCancelRequest',
  )
  const noSeller = existing?.job?.status === 'open'
  if (existing?.cancelRequest) {
    const cr = existing.cancelRequest
    if (cr.status === 'pending' && !noSeller)
      fail(
        `A cancel request is already pending for job ${jobId} (id: ${cr._id}).\n` +
        `Use "psilocli accept-cancel" or "psilocli decline-cancel" to resolve it.`,
        1,
      )
    if (cr.status === 'accepted')
      fail(`Job ${jobId} already has an accepted cancel request (status: ${cr.status}).`, 1)
  }

  if (noSeller) {
    const preview = describeRefund(existing?.refund)
    note(`No seller has accepted this job, so the cancellation takes effect now${preview ? `: ${preview}` : ''}`)
  }

  const result = sdkOk(
    await sdk.job.requestCancel(jobId, {
      reason: values.reason,
      ...(values.explanation ? { explanation: values.explanation } : {}),
    }),
    'job.requestCancel',
  )
  const cr = result?.cancelRequest
  if (config.json) {
    out({
      ok: true,
      cancelRequestId: cr?._id,
      autoResolved: Boolean(result?.autoResolved),
      refundTxHash: result?.refundTxHash ?? null,
      refundPending: Boolean(result?.refundPending),
    })
  } else if (result?.autoResolved) {
    print(`Cancelled — job status: ${result?.job?.status ?? 'cancelled'}`)
    if (result?.refundTxHash) print(`Refund tx:  ${result.refundTxHash}`)
    else if (result?.refundPending)
      print('Refund:     pending — the server will retry the on-chain refund; check `psilocli job`')
  } else {
    note('Cancel request submitted')
    print(`Request ID: ${cr?._id ?? '—'}`)
    print(`Status:     ${cr?.status ?? 'pending'}`)
    print(`Reason:     ${cr?.reason ?? values.reason}`)
  }
}
