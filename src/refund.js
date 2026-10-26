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

// The posted fee is `amount * feeBps / 1e4` with no minimum (fee flow
// 2026-10-05), so the rate always describes it. The server still sends a
// deprecated `feeFloor` of "0"; it is ignored.
function basisNote(bps) {
  return `${Number(bps ?? 0) / 100}%`
}

// Formats the server's refund preview (GET /v1/job/:id/cancel → refund).
// Fees are charged on top of the job value: the buyer deposited amount +
// posted fee, and a cancellation withholds part of THAT DEPOSIT — the job
// value itself always comes back in full. Returns null when there is nothing
// to refund or the preview is unavailable.
export function describeRefund(refund) {
  if (!refund || refund.amount == null) return null
  const fmt = formatter(refund.decimals ?? null, refund.symbol ?? '')
  const pct = (bps) => `${Number(bps ?? 0) / 100}%`
  if (refund.generation === 2) {
    // Pre-upgrade escrow: the fee comes OUT OF the amount, the old model.
    return (
      `refunds ${fmt(refund.netToBuyer)} of the ${fmt(refund.amount)} job value to buyer ` +
      `(platform fee ${fmt(refund.fee)} = ${pct(refund.feeBps)}, taken out of the amount: pre-upgrade escrow)`
    )
  }
  // 3.0.0: the rung is chosen by stage (5 bp before the seller commits, 15 bp
  // after), capped at $1 and at the posted fee (`refundFeeBps`/`feeCap` are
  // deprecated and null here), so quote the amount the contract gave us rather
  // than recomputing a rate.
  const withheld =
    Number(refund.fee ?? 0) > 0
      ? `after the ${fmt(refund.fee)} cancellation fee withheld from it`
      : 'with no cancellation fee withheld'
  return (
    `refunds ${fmt(refund.netToBuyer)} to buyer: the full ${fmt(refund.amount)} job value ` +
    `plus what is left of the ${fmt(refund.postedFee ?? refund.releaseFee)} fee deposit ${withheld}`
  )
}

// Formats the make-deposit terms: what create-job is about to move.
export function describeDeposit(d) {
  if (!d) return null
  const sym = d.coinSymbol ?? ''
  if (!d.totalAmount) return `amount: ${d.coinAmount} ${sym}`.trim()
  const basis = basisNote(d.feeBps)
  return `deposit ${d.totalAmount} ${sym} = ${d.coinAmount} job value + ${d.feeAmount} platform fee (${basis}, charged on top; the seller receives the full ${d.coinAmount})`.replace(/\s+/g, ' ')
}
