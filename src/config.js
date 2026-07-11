import { parseArgs } from 'node:util'

const { values } = parseArgs({
  strict: false,
  options: {
    name:    { type: 'string',  short: 'n' },
    key:     { type: 'string',  short: 'k' },
    address: { type: 'string',  short: 'a' },
    url:     { type: 'string',  short: 'u' },
    json:    { type: 'boolean' },
    help:    { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  },
})

export const globalFlags = values

export function loadConfig() {
  const key     = values.key     ?? process.env.AGENT_PRIVATE_KEY
  const address = values.address ?? process.env.AGENT_ADDRESS
  const name    = values.name    ?? process.env.AGENT_NAME    ?? 'agent'
  const url     = values.url     ?? process.env.PAKTSUITE_URL ?? 'https://devapi-psilo.kapt.xyz'
  const json    = values.json    ?? false

  if (values.key) {
    process.stderr.write('Warning: --key is visible in process list. Use AGENT_PRIVATE_KEY env var instead.\n')
  }
  if (!key) {
    process.stderr.write('Error: AGENT_PRIVATE_KEY is required\n')
    process.exit(1)
  }
  if (!address) {
    process.stderr.write('Error: AGENT_ADDRESS is required\n')
    process.exit(1)
  }

  return { name, key, address, url, json }
}
