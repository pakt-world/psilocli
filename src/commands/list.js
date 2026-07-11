import { parseCommand, resolveConfig } from '../config.js'
import { cliInit, sdkOk } from '../client.js'
import { out, print, fail, cliTable } from '../output.js'

export const usage =
  'psilocli list jobs [--status <s>] [--limit <n>] [--role <r>] | psilocli list invites'

export async function run(argv) {
  const sub = argv[0]

  if (sub === 'jobs') {
    const { values } = parseCommand(argv.slice(1), {
      status: { type: 'string' },
      limit: { type: 'string' },
      role: { type: 'string' },
    })
    const config = resolveConfig(values)
    const { sdk } = await cliInit(config)
    const listOpts = {
      status: values.status ?? 'open',
      limit: parseInt(values.limit ?? '20', 10),
      ...(values.role ? { role: values.role } : {}),
    }
    const result = sdkOk(await sdk.job.list(listOpts), 'job.list')
    const jobs = result?.data ?? (Array.isArray(result) ? result : [])
    if (config.json) {
      out(jobs)
    } else if (jobs.length === 0) {
      print('No jobs found.')
    } else {
      cliTable(
        jobs.map((j) => [
          String(j._id).slice(-8),
          (j.title ?? '').slice(0, 40),
          j.status ?? '',
          String(j.amount ?? ''),
          j.currency?.symbol ?? 'AVAX',
        ]),
        ['ID', 'Title', 'Status', 'Amount', 'Token'],
      )
    }
    return
  }

  if (sub === 'invites') {
    const { values } = parseCommand(argv.slice(1))
    const config = resolveConfig(values)
    const { sdk } = await cliInit(config)
    const { data: inviteList } = await sdk.job.listAllInvites()
    const invites = inviteList?.data ?? []
    if (config.json) {
      out(invites)
    } else if (invites.length === 0) {
      print('No invites found.')
    } else {
      cliTable(
        invites.map((i) => [
          String(i._id).slice(-8),
          (i.job?.title ?? '').slice(0, 40),
          i.direction ?? '',
          i.status ?? '',
          String(i.sender?._id ?? '').slice(-8),
        ]),
        ['ID', 'Job Title', 'Dir', 'Status', 'From'],
      )
    }
    return
  }

  fail(`Usage: ${usage}`, 2)
}
