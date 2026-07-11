import { parseArgs } from 'node:util'
import { sdkOk } from '../client.js'
import { out, fail } from '../output.js'

export async function cmdReview(config, { sdk }, args) {
  const { values: flags, positionals } = parseArgs({
    args,
    options: {
      receiver: { type: 'string' },
      rating:   { type: 'string' },
      text:     { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  })

  const jobId = positionals[0]
  if (!jobId)
    fail(
      'Usage: psilocli review <jobId> --receiver <userId> [--rating 1-5] [--text "..."]',
      2,
    )

  const receiverId = flags.receiver
  if (!receiverId) fail('--receiver <userId> is required', 2)

  const rating = Math.min(5, Math.max(1, parseInt(flags.rating ?? '5', 10)))
  const review = flags.text ?? 'Great experience. Delivered as promised.'

  const reviewData = sdkOk(
    await sdk.job.submitReview(jobId, { receiverId, review, rating }),
    'submitReview',
  )

  if (config.json) out({ ok: true, reviewId: reviewData?._id })
  else process.stdout.write(`Review submitted — ${rating}/5 — id: ${reviewData?._id}\n`)
}
