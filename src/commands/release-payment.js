import { parseCommand, resolveConfig } from '../config.js'
import { cliInit, sdkOk } from '../client.js'
import { escrowRelease, signAndBroadcast } from '../chains.js'
import { sleep } from '../messaging.js'
import { out, print, note, fail } from '../output.js'
import { disputedHint } from '../issues.js'

export const usage = 'psilocli release-payment <jobId> [--tx <hash>] [--rpc <url>]'

export async function run(argv) {
  const { values, positionals } = parseCommand(
    argv,
    { rpc: { type: 'string' }, tx: { type: 'string' } },
    { positionals: true },
  )
  const jobId = positionals[0]
  if (!jobId) fail(`Usage: ${usage}`, 2)

  const config = resolveConfig(values)
  const { sdk } = await cliInit(config)

  // Pre-flight: refuse before asking the server for a payload. The server and
  // the contract both reject a replay (status !== review; AlreadyReleased), so
  // this only saves a round trip, never a signature — but it also turns the
  // generic "No releasePayload returned" into the actual reason.
  const jobData = sdkOk(await sdk.job.getById(jobId), 'getById')
  const job = jobData?.job ?? jobData
  if (job?.escrowStatus === 'released' || job?.status === 'completed')
    fail(
      `Escrow for job ${jobId} was already released` +
        (job?.escrowReleaseTxHash ? ` (tx ${job.escrowReleaseTxHash})` : '') +
        '. Nothing signed.',
    )
  if (job?.status !== 'review')
    fail(`Job ${jobId} is ${job?.status ?? 'unknown'}; release is only possible in "review". Nothing signed.${disputedHint(job)}`)

  // The API can be behind the chain: a release that landed but whose confirmTx never ran (the
  // process was killed) leaves the job in review. Signing again would only revert with
  // AlreadyReleased, so confirm the release that landed instead.
  const onChain = job.escrowAddress
    ? await escrowRelease(sdk, job.escrowAddress, job.escrowChainId ?? job.chainId, values.rpc ?? null).catch((err) => {
        note(`Could not read the escrow on chain (${err.shortMessage ?? err.message}); continuing with the API.`)
        return { released: false, txHash: null }
      })
    : { released: false, txHash: null }
  if (values.tx && !onChain.released)
    fail(`--tx confirms a release that already landed, but escrow ${job.escrowAddress} has not released. Nothing signed.`, 2)
  if (onChain.released) {
    const txHash = values.tx ?? onChain.txHash
    if (!txHash)
      fail(
        `Escrow ${job.escrowAddress} has already released on chain, but its release is older than the blocks searched. ` +
          `Re-run with --tx <hash> (the escrow's Released transaction) to record it. Nothing signed.`,
      )
    note(`Escrow already released on chain (tx ${txHash}); recording it with the API — nothing signed.`)
    sdkOk(await sdk.job.confirmTx(jobId, { step: 'onRelease', txHash }), 'confirmTx onRelease')
    if (config.json) return out({ ok: true, jobId, txHash, recovered: true })
    return print(`Payment release recorded — txHash: ${txHash}`)
  }

  note(`Job "${job.title ?? jobId}" is in review — requesting release payload`)
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
