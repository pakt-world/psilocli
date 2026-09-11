import { ethers } from 'ethers'

// Formats token base-unit strings for humans. Falls back to base units when
// the server could not resolve the coin's decimals.
function formatter(decimals, sym) {
  return (v) => {
    if (v == null) return '—'
    if (decimals == null) return `${v} base units`
    const s = ethers.formatUnits(BigInt(v), decimals)
    const trimmed = s.includes('.') ? s.replace(/\.?0+$/, '') || '0' : s
    return sym ? `${trimmed} ${sym}` : trimmed
  }
}

// Formats the server's refund preview (GET /v1/job/:id/cancel → refund).
// Fees are charged on top of the job value: the buyer deposited amount +
// release fee, and a cancellation keeps min(1%, cap) of that deposit — the
// job value itself always comes back. Returns null when there is nothing to
// refund or the preview is unavailable.
export function describeRefund(refund) {
  if (!refund || refund.amount == null) return null
  const fmt = formatter(refund.decimals ?? null, refund.symbol ?? '')
  const pct = (bps) => `${Number(bps ?? 0) / 100}%`
  if (refund.generation === 2 || refund.feeCap == null) {
    // Pre-upgrade escrow: the fee comes out of the amount and is uncapped.
    return (
      `refunds ${fmt(refund.netToBuyer)} of the ${fmt(refund.amount)} job value to buyer ` +
      `(platform fee ${fmt(refund.fee)} = ${pct(refund.feeBps)}, no cap: pre-upgrade escrow)`
    )
  }
  return (
    `refunds ${fmt(refund.netToBuyer)} to buyer: the full ${fmt(refund.amount)} job value plus what is left of the ` +
    `${fmt(refund.releaseFee)} fee deposit after the cancellation fee ${fmt(refund.fee)} ` +
    `(= min(${pct(refund.refundFeeBps)}, cap ${fmt(refund.feeCap)}))`
  )
}

// Formats the make-deposit terms: what create-job is about to move.
export function describeDeposit(d) {
  if (!d) return null
  const sym = d.coinSymbol ?? ''
  if (!d.totalAmount) return `amount: ${d.coinAmount} ${sym}`.trim()
  return `deposit ${d.totalAmount} ${sym} = ${d.coinAmount} job value + ${d.feeAmount} platform fee (${Number(d.feeBps ?? 0) / 100}%, charged on top; the seller receives the full ${d.coinAmount})`.replace(/\s+/g, ' ')
}
