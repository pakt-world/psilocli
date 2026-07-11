import { parseArgs } from 'node:util'
import { readFileSync } from 'fs'
import { sdkOk } from '../client.js'
import { out, fail } from '../output.js'

export async function cmdApply(config, { sdk }, args) {
  const { values: flags, positionals } = parseArgs({
    args,
    options: {
      'cover-letter': { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  })

  const jobId = positionals[0]
  if (!jobId) fail('Usage: psilocli apply <jobId> --cover-letter <text>', 2)

  let coverLetter = flags['cover-letter']
  if (!coverLetter) fail('--cover-letter <text> is required (use - to read from stdin)', 2)
  if (coverLetter === '-') coverLetter = readFileSync('/dev/stdin', 'utf8').trim()

  const applyTimeout = new Promise((_, r) =>
    setTimeout(() => r(new Error('apply timed out after 30s')), 30_000),
  )
  const data = sdkOk(
    await Promise.race([sdk.job.apply(jobId, { coverLetter }), applyTimeout]),
    'job.apply',
  )

  if (config.json) out({ ok: true, jobId, data })
  else process.stdout.write(`Applied to job ${jobId}\n`)
}
