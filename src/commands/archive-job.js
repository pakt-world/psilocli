import { parseCommand, resolveConfig } from '../config.js'
import { cliInit, sdkOk } from '../client.js'
import { out, print, note, fail } from '../output.js'

export const usage = 'psilocli archive-job <jobId>'

// Replaces delete-job (0.3.0). Nothing is deleted: the server hides the job
// from every listing that does not pass --include-archived. Only completed,
// cancelled, or open jobs qualify, and an open job whose escrow still holds
// funds is refused — the server names the escrow so the caller can refund it
// (cancel-job) or finish it (create-job --resume) first.
export async function run(argv) {
  const { values, positionals } = parseCommand(argv, {}, { positionals: true })
  const jobId = positionals[0]
  if (!jobId) fail(`Usage: ${usage}`, 2)

  const config = resolveConfig(values)
  const { sdk } = await cliInit(config)

  // Pre-flight so the refusal names the state before a round trip; the server
  // re-checks the same rules and is the authority.
  const jobData = sdkOk(await sdk.job.getById(jobId), 'getById')
  const job = jobData?.job ?? jobData
  if (job?.isArchived) {
    if (config.json) out({ ok: true, jobId, archived: true, alreadyArchived: true })
    else print(`Job ${jobId} is already archived.`)
    return
  }
  if (!['completed', 'cancelled', 'open'].includes(job?.status))
    fail(
      `Cannot archive job ${jobId}: it is ${job?.status ?? 'unknown'}. ` +
        'Only completed, cancelled, or open jobs can be archived.',
    )
  note(`Archiving "${job.title ?? jobId}" (${job.status})`)

  const result = sdkOk(await sdk.job.archive(jobId), 'job.archive')
  if (config.json) {
    out({ ok: true, jobId, archived: true, message: result?.message })
  } else {
    print(result?.message ?? `Job ${jobId} archived`)
    print('It no longer appears in listings; pass --include-archived to list jobs --owner to see it.')
  }
}
