import { parseArgs } from 'node:util'
import { sdkOk } from '../client.js'
import { out, fail, cliTable } from '../output.js'

export async function cmdList(config, { sdk }, args) {
  const sub = args[0]

  if (sub === 'jobs') {
    const { values: flags } = parseArgs({
      args: args.slice(1),
      options: {
        status: { type: 'string' },
        limit:  { type: 'string' },
        role:   { type: 'string' },
      },
      strict: true,
    })
    const status = flags.status ?? 'open'
    const limit  = parseInt(flags.limit ?? '20', 10)
    const listOpts = { status, limit, ...(flags.role ? { role: flags.role } : {}) }

    const result = sdkOk(await sdk.job.list(listOpts), 'job.list')
    const jobs = result?.data ?? (Array.isArray(result) ? result : [])

    if (config.json) {
      out(jobs)
    } else if (jobs.length === 0) {
      process.stdout.write('No jobs found.\n')
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
    const result = sdkOk(await sdk.job.listAllInvites(), 'listAllInvites')
    const invites = result?.data ?? (Array.isArray(result) ? result : [])

    if (config.json) {
      out(invites)
    } else if (invites.length === 0) {
      process.stdout.write('No invites found.\n')
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

  fail('Usage: psilocli list jobs | psilocli list invites', 2)
}
