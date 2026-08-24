import { parseCommand, resolveConfig } from '../config.js'
import { cliInit, sdkOk } from '../client.js'
import { out, print, fail } from '../output.js'

export const usage = 'psilocli delete-job <jobId>'

export async function run(argv) {
  const { values, positionals } = parseCommand(argv, {}, { positionals: true })
  const jobId = positionals[0]
  if (!jobId) fail(`Usage: ${usage}`, 2)

  const config = resolveConfig(values)
  const { sdk } = await cliInit(config)

  const result = sdkOk(await sdk.job.delete(jobId), 'job.delete')
  if (config.json) {
    out({ ok: true, message: result?.message })
  } else {
    print(result?.message ?? `Job ${jobId} deleted`)
  }
}
