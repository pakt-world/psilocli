import { parseCommand, resolveConfig } from '../config.js'
import { cliInit, sdkOk } from '../client.js'
import { out, print, note, fail } from '../output.js'

export const usage =
  'psilocli reviews me [--limit <n>] [--page <n>]\n' +
  'psilocli reviews <userId> [--limit <n>] [--page <n>]'

export async function run(argv) {
  const { values, positionals } = parseCommand(
    argv,
    {
      limit: { type: 'string' },
      page:  { type: 'string' },
    },
    { positionals: true },
  )
  const target = positionals[0]
  if (!target) fail(`Usage: ${usage}`, 2)

  const config = resolveConfig(values)
  const { sdk, userId } = await cliInit(config)

  const receiverId = target === 'me' ? userId : target
  const query = {}
  if (values.limit) query.limit = parseInt(values.limit, 10)
  if (values.page)  query.page  = parseInt(values.page,  10)

  const result = sdkOk(
    await sdk.job.getReceivedReviews(receiverId, query),
    'job.getReceivedReviews',
  )
  const reviews = result?.data ?? []
  const total   = result?.total ?? reviews.length

  if (config.json) {
    out(result)
    return
  }

  if (reviews.length === 0) {
    print('No reviews yet.')
    return
  }

  const avg = reviews.reduce((sum, r) => sum + (r.rating ?? 0), 0) / reviews.length
  note(`${reviews.length} review(s) shown — average: ${avg.toFixed(1)} ★ (total on record: ${total})`)

  for (const r of reviews) {
    const reviewer = r.owner
      ? (`${r.owner.firstName ?? ''} ${r.owner.lastName ?? ''}`.trim() ||
         String(r.owner._id ?? r.owner).slice(-8))
      : '—'
    const rating = r.rating ?? 0
    const stars  = '★'.repeat(Math.min(5, Math.max(0, rating))) +
                   '☆'.repeat(Math.max(0, 5 - rating))
    const date   = r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 10) : ''
    print(`${stars}  ${reviewer}  ${date}`)
    if (r.review) print(`       ${r.review.slice(0, 120)}`)
  }
}
