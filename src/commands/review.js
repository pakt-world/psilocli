import { parseCommand, resolveConfig } from '../config.js'
import { cliInit, sdkOk } from '../client.js'
import { out, print, fail } from '../output.js'

export const usage =
  'psilocli review <jobId> --receiver <userId> [--rating 1-5] [--text "..."]'

export async function run(argv) {
  const { values, positionals } = parseCommand(
    argv,
    {
      receiver: { type: 'string' },
      rating: { type: 'string' },
      text: { type: 'string' },
    },
    { positionals: true },
  )
  const jobId = positionals[0]
  if (!jobId) fail(`Usage: ${usage}`, 2)
  const receiverId = values.receiver
  if (!receiverId) fail('--receiver <userId> is required', 2)
  const rating = Math.min(5, Math.max(1, parseInt(values.rating ?? '5', 10)))
  const review = values.text ?? 'Great experience. Delivered as promised.'

  const config = resolveConfig(values)
  const { sdk } = await cliInit(config)
  const reviewData = sdkOk(
    await sdk.job.submitReview(jobId, { receiverId, review, rating }),
    'submitReview',
  )
  if (config.json) out({ ok: true, reviewId: reviewData?._id })
  else print(`Review submitted — ${rating}/5 — id: ${reviewData?._id}`)
}
