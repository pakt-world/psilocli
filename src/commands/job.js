import { parseCommand, resolveConfig } from '../config.js'
import { cliInit, sdkOk } from '../client.js'
import { out, print, note, fail, cliTable } from '../output.js'
import { describeRefund } from '../refund.js'

export const usage = 'psilocli job <id>'

export async function run(argv) {
  const { values, positionals } = parseCommand(argv, {}, { positionals: true })
  const id = positionals[0]
  if (!id) fail(`Usage: ${usage}`, 2)

  const config = resolveConfig(values)
  const { sdk } = await cliInit(config)

  const result = sdkOk(await sdk.job.getById(id), 'job.getById')
  const job = result?.job ?? result

  // A pending cancel request carries the refund preview (fee = 5 or 15 bp by stage, capped at $1).
  // Only parties can read it; anyone else just gets the job.
  let cancel = null
  if (['open', 'ongoing', 'review', 'cancelling'].includes(job.status)) {
    try {
      const cr = await sdk.job.getCancelRequest(id)
      if (cr && cr.status !== 'error') cancel = cr.data ?? null
    } catch {
      cancel = null
    }
  }
  const pendingCancel = cancel?.cancelRequest?.status === 'pending' ? cancel : null

  if (config.json) {
    out(pendingCancel ? { ...job, cancelRequest: pendingCancel.cancelRequest, refund: pendingCancel.refund ?? null } : job)
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
  // Buyer, seller and escrow address are withheld from non-parties (an invitee
  // is not a party until it accepts), so absent means "not shown", not "none".
  print(`Buyer:        ${job.buyer || '—'}`)
  print(`Seller:       ${job.seller || job.sellerId || '—'}`)
  print(`Escrow:       ${job.escrowAddress || '—'}`)
  print(`Escrow status: ${job.escrowStatus || '—'}`)
  if (job.isArchived) print(`Archived:     yes${job.archivedAt ? ` (${new Date(job.archivedAt).toISOString().slice(0, 10)})` : ''}`)
  if (job.escrowRefundTxHash) print(`Refund tx:    ${job.escrowRefundTxHash}`)
  if (job.issue) {
    // A disputed job's escrow is frozen: no release, cancel or completion until the panel decides.
    const frozen = job.status === 'disputed' ? ' — escrow frozen; see psilocli issue show ' + String(job.issue?._id ?? job.issue) : ''
    print(`Issue:        ${job.issue?._id ?? job.issue}${frozen}`)
  }
  if (pendingCancel) {
    const cr = pendingCancel.cancelRequest
    print(`Cancel req:   pending (id ${cr._id}, reason: ${cr.reason ?? ''})`)
    const preview = describeRefund(pendingCancel.refund)
    print(`  accepting ${preview ?? 'cancels without an on-chain refund (escrow not funded)'}`)
  }
  if (job.description)
    print(`Description:  ${job.description}`)
  if (job.deliverables?.length) {
    note('Deliverables:')
    cliTable(
      job.deliverables.map((d, i) => [
        String(i + 1),
        d.title ?? d.name ?? '',
        d.status ?? '',
      ]),
      ['#', 'Title', 'Status'],
    )
  }
  if (!job.escrowAddress && job.escrowStatus) note('Escrow details are shown to the buyer and seller only (an invitee sees them once it accepts).')
  print(`Created:      ${job.createdAt ? new Date(job.createdAt).toISOString().slice(0, 10) : ''}`)
}
