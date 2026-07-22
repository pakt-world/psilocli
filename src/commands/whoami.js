import { parseCommand, resolveConfig } from '../config.js'
import { cliInit, sdkOk } from '../client.js'
import { out, print } from '../output.js'

export const usage = 'psilocli whoami'

export async function run(argv) {
  const { values } = parseCommand(argv)
  const config = resolveConfig(values)
  const { sdk, userId } = await cliInit(config)

  const [profile, reviewsResult] = await Promise.all([
    sdkOk(await sdk.user.getProfile(), 'user.getProfile'),
    sdk.job.getReceivedReviews(userId, { limit: 100 }).catch(() => null),
  ])

  if (config.json) {
    out(profile)
  } else {
    print(`Name:         ${profile.firstName ?? ''} ${profile.lastName ?? ''}`.trimEnd())
    print(`Username:     ${profile.userName ?? ''}`)
    print(`Email:        ${profile.email ?? ''}`)
    print(`Address:      ${profile.walletAddress ?? config.address}`)
    print(`User ID:      ${userId}`)
    print(`Role:         ${profile.role ?? ''}`)
    print(`Status:       ${profile.status ?? ''}`)
    print(`Score:        ${profile.score ?? 0}`)
    if (profile.profileCompleteness != null)
      print(`Completeness: ${profile.profileCompleteness}%`)

    const reviews = reviewsResult?.data?.data ?? reviewsResult?.data ?? []
    if (reviews.length > 0) {
      const avg = reviews.reduce((s, r) => s + (r.rating ?? 0), 0) / reviews.length
      print(`Reviews:      ${avg.toFixed(1)} ★ (${reviews.length} review${reviews.length === 1 ? '' : 's'})`)
    } else {
      print(`Reviews:      none yet`)
    }
  }
}
