import { parseCommand, resolveConfig } from '../config.js'
import { cliInit, sdkOk } from '../client.js'
import { out, print, note, fail, cliTable } from '../output.js'

export const usage = 'psilocli job <id>'

export async function run(argv) {
  const { values, positionals } = parseCommand(argv, {}, { positionals: true })
  const id = positionals[0]
  if (!id) fail(`Usage: ${usage}`, 2)

  const config = resolveConfig(values)
  const { sdk } = await cliInit(config)

  const result = sdkOk(await sdk.job.getById(id), 'job.getById')
  const job = result?.job ?? result

  if (config.json) {
    out(job)
    return
  }

  print(`ID:           ${job._id}`)
  print(`Title:        ${job.title ?? ''}`)
  print(`Status:       ${job.status ?? ''}`)
  const currencyDisplay = typeof job.currency === 'object'
    ? (job.currency?.symbol ?? job.currency?.name ?? '')
    : (job.currency ?? '')
  print(`Amount:       ${job.amount ?? ''} ${currencyDisplay}`)
  print(`Chain:        ${job.chainId ?? ''}`)
  print(`Asset:        ${job.asset || '(native)'}`)
  print(`Buyer:        ${job.buyer ?? ''}`)
  print(`Seller:       ${job.seller ?? job.sellerId ?? '—'}`)
  print(`Escrow:       ${job.escrowAddress ?? '—'}`)
  print(`Escrow status:${job.escrowStatus ?? '—'}`)
  if (job.description)
    print(`Description:  ${job.description}`)
  if (job.deliverables?.length) {
    note('Deliverables:')
    cliTable(
      job.deliverables.map((d, i) => [
        String(i + 1),
        d.name ?? '',
        `${d.progress ?? 0}%`,
      ]),
      ['#', 'Name', 'Progress'],
    )
  }
  print(`Created:      ${job.createdAt ? new Date(job.createdAt).toISOString().slice(0, 10) : ''}`)
}
