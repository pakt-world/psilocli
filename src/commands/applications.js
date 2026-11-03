import { parseCommand, resolveConfig } from '../config.js'
import { cliInit, sdkOk } from '../client.js'
import { out, print, note, fail, cliTable } from '../output.js'

// The buyer's side of an open job (create-job --open): review applications, accept one (which
// invites that applicant and rejects the rest), or reject one.
export const usage = `psilocli applications list <jobId> [--status pending|accepted|rejected|closed]
psilocli applications accept <jobId> <applicationId>
psilocli applications reject <jobId> <applicationId>`

const nameOf = (a) =>
  `${a?.firstName ?? ''} ${a?.lastName ?? ''}`.trim() || String(a?._id ?? a ?? '')

async function list(argv) {
  const { values, positionals } = parseCommand(argv, { status: { type: 'string' } }, { positionals: true })
  const jobId = positionals[0]
  if (!jobId) fail(`Usage:\n${usage}`, 2)
  const config = resolveConfig(values)
  const { sdk } = await cliInit(config)
  const res = sdkOk(
    await sdk.job.listApplications(jobId, values.status ? { status: values.status } : undefined),
    'job.listApplications',
  )
  const rows = res?.data ?? res?.applications ?? []
  if (config.json) return out(rows)
  if (rows.length === 0) return print('No applications.')
  cliTable(
    rows.map((a) => [
      a._id,
      nameOf(a.applicant),
      a.status,
      (a.coverLetter ?? '').replace(/\s+/g, ' ').slice(0, 60),
    ]),
    ['Application', 'Applicant', 'Status', 'Cover letter'],
  )
}

async function accept(argv) {
  const { values, positionals } = parseCommand(argv, {}, { positionals: true })
  const [jobId, appId] = positionals
  if (!jobId || !appId) fail(`Usage:\n${usage}`, 2)
  const config = resolveConfig(values)
  const { sdk } = await cliInit(config)
  const res = sdkOk(await sdk.job.acceptApplication(jobId, appId), 'job.acceptApplication')
  if (config.json) return out({ ok: true, jobId, applicationId: appId, status: res?.application?.status })
  print(`Accepted application ${appId}: the applicant is invited to job ${jobId}.`)
  note('The other applications were rejected. The job starts once the applicant accepts the invite.')
}

async function reject(argv) {
  const { values, positionals } = parseCommand(argv, {}, { positionals: true })
  const [jobId, appId] = positionals
  if (!jobId || !appId) fail(`Usage:\n${usage}`, 2)
  const config = resolveConfig(values)
  const { sdk } = await cliInit(config)
  sdkOk(await sdk.job.rejectApplication(jobId, appId), 'job.rejectApplication')
  if (config.json) return out({ ok: true, jobId, applicationId: appId, status: 'rejected' })
  print(`Rejected application ${appId}.`)
}

const SUBCOMMANDS = { list, accept, reject }

export async function run(argv) {
  const handler = SUBCOMMANDS[argv[0]]
  if (!handler) fail(`Usage:\n${usage}`, 2)
  await handler(argv.slice(1))
}
