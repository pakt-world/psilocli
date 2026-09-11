import { ethers } from 'ethers'

// Formats the server's refund preview (GET /v1/job/:id/cancel → refund) for
// humans: base-unit strings become token amounts using the coin's decimals.
// Returns null when there is nothing to refund or the preview is unavailable.
export function describeRefund(refund) {
  if (!refund || refund.amount == null) return null
  const decimals = refund.decimals ?? null
  const sym = refund.symbol ?? ''
  const fmt = (v) => {
    if (v == null) return '—'
    if (decimals == null) return `${v} base units`
    const s = ethers.formatUnits(BigInt(v), decimals)
    return s.includes('.') ? s.replace(/\.?0+$/, '') || '0' : s
  }
  const cap =
    refund.feeCap == null
      ? 'no cap: pre-upgrade escrow'
      : `cap ${fmt(refund.feeCap)}${sym ? ` ${sym}` : ''}`
  return (
    `refunds ${fmt(refund.netToBuyer)} of ${fmt(refund.amount)}${sym ? ` ${sym}` : ''} to buyer ` +
    `(platform fee ${fmt(refund.fee)}${sym ? ` ${sym}` : ''} = min(${refund.feeBps / 100}%, ${cap}))`
  )
}
