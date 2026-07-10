import { parseCommand, resolveConfig } from '../config.js'
import { cliInit, sdkOk } from '../client.js'
import { out, print, fail } from '../output.js'

export const usage = 'psilocli decline-invite <jobId> <inviteId>'

export async function run(argv) {
  const { values, positionals } = parseCommand(argv, {}, { positionals: true })
  const [jobId, inviteId] = positionals
  if (!jobId || !inviteId) fail(`Usage: ${usage}`, 2)

  const config = resolveConfig(values)
  const { sdk } = await cliInit(config)
  sdkOk(await sdk.job.declineInvite(jobId, inviteId), 'declineInvite')
  if (config.json) out({ ok: true, jobId, inviteId })
  else print(`Declined invite ${inviteId}`)
}
