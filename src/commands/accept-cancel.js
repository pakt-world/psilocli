import { parseCommand, resolveConfig } from '../config.js'
import { cliInit, sdkOk } from '../client.js'
import { out, print, note, fail } from '../output.js'
import { describeRefund } from '../refund.js'

export const usage = 'psilocli accept-cancel <jobId> [--resolution <s>]'

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

  // Show the number BEFORE the buyer agrees: the server reads the escrow's own
  // fee terms (min(1%, cap)) so this is what the contract will pay out.
  const pending = sdkOk(await sdk.job.getCancelRequest(jobId), 'job.getCancelRequest')
  const cr0 = pending?.cancelRequest
  if (!cr0 || cr0.status !== 'pending')
    fail(
      cr0
        ? `The latest cancel request on job ${jobId} is ${cr0.status}; nothing pending to accept.`
        : `No cancel request on job ${jobId}.`,
    )
  const preview = describeRefund(pending?.refund)
  if (preview) note(`Accepting ${preview}`)
  else note('Accepting cancellation (no funded escrow to refund, or fee preview unavailable)')

  const result = sdkOk(
    await sdk.job.acceptCancel(
      jobId,
      values.resolution ? { resolution: values.resolution } : undefined,
    ),
    'job.acceptCancel',
  )
  const cr = result?.cancelRequest
  if (config.json) {
    out({
      ok: true,
      cancelRequestId: cr?._id,
      jobStatus: result?.job?.status,
      escrowStatus: result?.job?.escrowStatus,
      refund: result?.refund ?? pending?.refund ?? null,
      refundTxHash: result?.refundTxHash ?? null,
      refundPending: Boolean(result?.refundPending),
    })
  } else {
    print(`Cancel accepted — job status: ${result?.job?.status ?? '—'}`)
    if (cr?.resolution) print(`Resolution: ${cr.resolution}`)
    if (result?.refundTxHash) print(`Refund tx:  ${result.refundTxHash}`)
    else if (result?.refundPending)
      print('Refund:     pending — the server will retry the on-chain refund; check `psilocli job` for escrowRefundTxHash')
    const settled = describeRefund(result?.refund ?? pending?.refund)
    if (settled && result?.refundTxHash) print(`Refunded:   ${settled}`)
  }
}
