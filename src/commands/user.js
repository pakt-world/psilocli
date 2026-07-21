import { parseCommand, resolveConfig } from '../config.js'
import { cliInit, sdkOk } from '../client.js'
import { out, print, note, fail, cliTable } from '../output.js'

export const usage =
  'psilocli user get <id>\n' +
  'psilocli user update [--first-name <s>] [--last-name <s>] [--username <s>]\n' +
  '                     [--profile-image <id>] [--bg-image <id>] [--private]'

async function runGet(argv) {
  const { values, positionals } = parseCommand(argv, {}, { positionals: true })
  const id = positionals[0]
  if (!id) fail('Usage: psilocli user get <id>', 2)

  const config = resolveConfig(values)
  const { sdk } = await cliInit(config)

  const profile = sdkOk(await sdk.user.getUserById(id), 'user.getUserById')

  if (config.json) {
    out(profile)
  } else {
    print(`Name:     ${profile.firstName ?? ''} ${profile.lastName ?? ''}`.trimEnd())
    print(`Username: ${profile.userName ?? ''}`)
    print(`Address:  ${profile.walletAddress ?? ''}`)
    print(`User ID:  ${profile._id}`)
    print(`Role:     ${profile.role ?? ''}`)
    print(`Score:    ${profile.score ?? 0}`)
    print(`Verified: ${profile.isVerified ? 'yes' : 'no'}`)
    if (profile.profile?.talent?.tags?.length)
      print(`Tags:     ${profile.profile.talent.tags.join(', ')}`)
  }
}

async function runUpdate(argv) {
  const { values } = parseCommand(argv, {
    'first-name':     { type: 'string' },
    'last-name':      { type: 'string' },
    'username':       { type: 'string' },
    'profile-image':  { type: 'string' },
    'bg-image':       { type: 'string' },
    'private':        { type: 'boolean' },
  })

  const config = resolveConfig(values)
  const { sdk } = await cliInit(config)

  const data = {}
  if (values['first-name']    !== undefined) data.firstName    = values['first-name']
  if (values['last-name']     !== undefined) data.lastName     = values['last-name']
  if (values['username']      !== undefined) data.userName     = values['username']
  if (values['profile-image'] !== undefined) data.profileImage = values['profile-image']
  if (values['bg-image']      !== undefined) data.bgImage      = values['bg-image']
  if (values['private']       !== undefined) data.isPrivate    = values['private']

  if (Object.keys(data).length === 0) {
    fail(`No fields provided. Usage: ${usage}`, 2)
  }

  const result = sdkOk(await sdk.user.update(data), 'user update')

  if (config.json) {
    out(result)
  } else {
    cliTable(
      [[
        String(result._id).slice(-12),
        result.firstName ?? '',
        result.lastName ?? '',
        result.email ?? '',
        result.type ?? '',
        String(result.profileCompleteness ?? ''),
        result.isVerified ? 'yes' : 'no',
      ]],
      ['ID', 'First', 'Last', 'Email', 'Type', 'Complete%', 'Verified'],
    )
  }
}

export async function run(argv) {
  const sub = argv[0]

  if (sub === 'get')    return runGet(argv.slice(1))
  if (sub === 'update') return runUpdate(argv.slice(1))

  fail(`Usage:\n${usage}`, 2)
}
