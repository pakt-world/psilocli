import { readFileSync } from 'node:fs'
import { parseCommand, resolveConfig } from '../config.js'
import { cliInit, sdkOk } from '../client.js'
import { withTimeout } from '../messaging.js'
import { out, print, fail } from '../output.js'

export const usage = 'psilocli apply <jobId> --cover-letter <text | ->'

export async function run(argv) {
  const { values, positionals } = parseCommand(
    argv,
    { 'cover-letter': { type: 'string' } },
    { positionals: true },
  )
  const jobId = positionals[0]
  if (!jobId) fail(`Usage: ${usage}`, 2)
  let coverLetter = values['cover-letter']
  if (!coverLetter) fail('--cover-letter is required (use - to read stdin)', 2)
  if (coverLetter === '-') coverLetter = readFileSync(0, 'utf8').trim()
  if (!coverLetter) fail('cover letter is empty', 2)

  const config = resolveConfig(values)
  const { sdk } = await cliInit(config)
  const data = sdkOk(
    await withTimeout(sdk.job.apply(jobId, { coverLetter }), 30_000, 'job.apply'),
    'job.apply',
  )
  if (config.json) out({ ok: true, jobId, data })
  else print(`Applied to job ${jobId}`)
}
