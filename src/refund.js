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

// Describes what actually set the fee. The posted fee is
// `max(amount * feeBps / 1e4, feeFloor)`, so on any job below the crossover
// (~83.34 USDC at 30 bp / $0.25) the FLOOR governs and the rate is a lie: a
// 10 USDC job posts 0.25, which is 2.5% of the job, not 0.3%. Printing the
// bare rate next to the real amount is what made one transaction look like it
// had three different fee numbers. Returns "" when the rate governs normally.
function basisNote(feeAmount, bps, floor) {
  const rate = `${Number(bps ?? 0) / 100}%`
  if (floor == null || feeAmount == null) return rate
  // Compare as strings-of-numbers; both come from the server in the same units.
  const fee = Number(feeAmount)
  const flr = Number(floor)
  if (!Number.isFinite(fee) || !Number.isFinite(flr) || flr <= 0) return rate
  return fee > flr ? rate : `minimum fee, not ${rate}`
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
  // 3.0.0: no separate refund rate and no cap (`refundFeeBps`/`feeCap` are
  // deprecated and null here) — the rung is chosen by stage and floored, so
  // quote the amount the contract gave us rather than recomputing a rate.
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
  const basis = basisNote(d.feeAmount, d.feeBps, d.feeFloor)
  return `deposit ${d.totalAmount} ${sym} = ${d.coinAmount} job value + ${d.feeAmount} platform fee (${basis}, charged on top; the seller receives the full ${d.coinAmount})`.replace(/\s+/g, ' ')
}
