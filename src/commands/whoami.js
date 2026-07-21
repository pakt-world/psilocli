import { parseCommand, resolveConfig } from '../config.js'
import { cliInit, sdkOk } from '../client.js'
import { out, print } from '../output.js'

export const usage = 'psilocli whoami'

export async function run(argv) {
  const { values } = parseCommand(argv)
  const config = resolveConfig(values)
  const { sdk, userId } = await cliInit(config)
  const profile = sdkOk(await sdk.user.getProfile(), 'user.getProfile')
  if (config.json) {
    out(profile)
  } else {
    print(`Name:     ${profile.firstName ?? ''} ${profile.lastName ?? ''}`.trimEnd())
    print(`Username: ${profile.userName ?? ''}`)
    print(`Email:    ${profile.email ?? ''}`)
    print(`Address:  ${profile.walletAddress ?? config.address}`)
    print(`User ID:  ${userId}`)
    print(`Role:     ${profile.role ?? ''}`)
    print(`Status:   ${profile.status ?? ''}`)
    print(`Score:    ${profile.score ?? 0}`)
  }
}
