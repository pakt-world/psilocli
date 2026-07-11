import { parseArgs } from 'node:util'
import { fail } from './output.js'

export const DEFAULT_URL = 'https://devapi-psilo.kapt.xyz'

// Flags accepted by every subcommand, merged into each command's own options.
export const GLOBAL_OPTIONS = {
  name: { type: 'string', short: 'n' },
  key: { type: 'string', short: 'k' },
  address: { type: 'string', short: 'a' },
  url: { type: 'string', short: 'u' },
  json: { type: 'boolean' },
}

// strict parseArgs wrapper — typo'd flags are a usage error (exit 2), not
// silently ignored.
export function parseCommand(argv, options = {}, { positionals = false } = {}) {
  try {
    return parseArgs({
      args: argv,
      options: { ...GLOBAL_OPTIONS, ...options },
      allowPositionals: positionals,
      strict: true,
    })
  } catch (err) {
    fail(err.message, 2)
  }
}

export function resolveConfig(values, { requireAuth = true } = {}) {
  if (values.key) {
    process.stderr.write(
      'Warning: --key on the command line is visible in shell history and process lists — prefer the AGENT_PRIVATE_KEY environment variable\n',
    )
  }
  const config = {
    name: values.name ?? process.env.AGENT_NAME ?? 'agent',
    key: values.key ?? process.env.AGENT_PRIVATE_KEY,
    address: values.address ?? process.env.AGENT_ADDRESS,
    url: values.url ?? process.env.PAKTSUITE_URL ?? DEFAULT_URL,
    json: Boolean(values.json),
  }
  if (requireAuth) {
    if (!config.key) fail('--key / AGENT_PRIVATE_KEY is required')
    if (!config.address) fail('--address / AGENT_ADDRESS is required')
  }
  return config
}
