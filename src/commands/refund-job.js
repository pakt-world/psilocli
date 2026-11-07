import { parseCommand, resolveConfig } from '../config.js'
import { cliInit, sdkOk } from '../client.js'
import { signAndBroadcast } from '../chains.js'
import { out, print, note, fail } from '../output.js'
import { describeRefund } from '../refund.js'
import { partyRole } from '../issues.js'

// The seller returns the escrowed funds to the buyer (relinquishes the job). No buyer consent is
// needed, and once the work is marked ready it is the only way a job can be cancelled: the
// escrow lets only the seller refund from then on.
export const usage = 'psilocli refund-job <jobId> --yes [--rpc <url>]'

export async function run(argv) {
  const { values, positionals } = parseCommand(
    argv,
    { yes: { type: 'boolean' }, rpc: { type: 'string' } },
    { positionals: true },
  )
  const jobId = positionals[0]
  if (!jobId) fail(`Usage: ${usage}`, 2)

  const config = resolveConfig(values)
  const { sdk, userId } = await cliInit(config)

  const jobData = sdkOk(await sdk.job.getById(jobId), 'getById')
  const job = jobData?.job ?? jobData
  if (partyRole(job, userId) !== 'seller')
    fail(`Only the accepted seller of job ${jobId} can return its funds.`)
  if (['completed', 'cancelled'].includes(job.status))
    fail(`Job ${jobId} is ${job.status}; there is nothing to refund. Nothing signed.`)

  const preview = describeRefund(sdkOk(await sdk.job.getCancelRequest(jobId), 'job.getCancelRequest')?.refund)
  if (!values.yes)
    fail(
      `Returning the funds of job ${jobId} gives up the job: ${preview ?? 'the buyer is refunded'}. ` +
        'It cannot be undone. Re-run with --yes to refund.',
      2,
    )

  const res = sdkOk(await sdk.job.refund(jobId), 'job.refund')
  let txHash = res?.refundTxHash ?? null
  if (!txHash && res?.refundPayload) {
    // Self-custody seller: sign refundBuyer() ourselves, then let the API verify it.
    note('Signing refundBuyer() on the escrow...')
    txHash = await signAndBroadcast(sdk, config.key, res.refundPayload, values.rpc ?? null)
    sdkOk(await sdk.job.confirmTx(jobId, { step: 'onRefund', txHash }), 'confirmTx onRefund')
  }
  if (!txHash) fail('The API returned neither a refund transaction nor a payload to sign.')

  if (config.json) return out({ ok: true, jobId, refundTxHash: txHash })
  print(`Funds returned to the buyer — txHash: ${txHash}`)
  if (preview) print(`Refunded:   ${preview}`)
}
