import { Wallet } from 'ethers'
import { PsiloSDK } from '@pakt/psilo'
import { parseCommand, resolveConfig } from '../config.js'
import { out, print, note, fail } from '../output.js'

export const usage =
  'psilocli auth register [--first-name <s>] [--last-name <s>] [--email <s>]\n' +
  '       psilocli auth request\n' +
  '       psilocli auth validate --signed-message <s> --temp-token <s> [--token-id <s>]\n' +
  '       psilocli auth onboard  --temp-token <s> --email <s> [--first-name <s>] [--last-name <s>]'

async function initSdk(config) {
  return PsiloSDK.init({ baseUrl: config.url })
}

// psilocli auth register
async function runRegister(argv) {
  const { values } = parseCommand(argv, {
    'first-name': { type: 'string' },
    'last-name':  { type: 'string' },
    'email':      { type: 'string' },
  })

  const config = resolveConfig(values, { requireAuth: true })
  const sdk    = await initSdk(config)
  const wallet = new Wallet(config.key)

  const firstName = values['first-name'] ?? config.address
  const lastName  = values['last-name']  ?? config.address
  const email     = values['email']      ?? `${config.address.toLowerCase()}@pakt.internal`

  if (!values['email']) {
    process.stderr.write(
      `Warning: --email not provided; using placeholder "${email}". ` +
      'Run "psilocli user update --first-name ... --last-name ... " afterwards to set real details.\n',
    )
  }

  note('Requesting web3 challenge…')
  const { message, tempToken } = await sdk.auth.web3AuthRequest(config.address)

  note('Signing challenge…')
  const signedMessage = await wallet.signMessage(message)

  note('Validating signature…')
  const validateResult = await sdk.auth.web3AuthValidate(signedMessage, tempToken)

  if (validateResult.token) {
    // Wallet is already registered — return the JWT directly
    note('Wallet already registered.')
    if (config.json) {
      out({ token: validateResult.token, registered: false })
    } else {
      print(validateResult.token)
    }
    return
  }

  if (!validateResult.tempToken) {
    fail('Unexpected response from web3/validate: no token or tempToken')
  }

  note('Onboarding new wallet…')
  await sdk.auth.web3AuthOnboard(validateResult.tempToken, firstName, lastName, email)

  note('Re-authenticating after onboarding…')
  const { message: msg2, tempToken: token2 } = await sdk.auth.web3AuthRequest(config.address)
  const signed2 = await wallet.signMessage(msg2)
  const finalResult = await sdk.auth.web3AuthValidate(signed2, token2)

  if (!finalResult.token) {
    fail('Web3 authentication failed after onboarding')
  }

  if (config.json) {
    out({ token: finalResult.token, registered: true })
  } else {
    note('Registered and authenticated.')
    print(finalResult.token)
  }
}

// psilocli auth request
async function runRequest(argv) {
  const { values } = parseCommand(argv)

  const config = resolveConfig(values, { requireAuth: false })
  if (!config.address) fail('--address / AGENT_ADDRESS is required')

  const sdk = await initSdk(config)

  note('Requesting web3 challenge…')
  const result = await sdk.auth.web3AuthRequest(config.address)

  if (config.json) {
    out(result)
  } else {
    print(`message:   ${result.message}`)
    print(`tempToken: ${result.tempToken}`)
  }
}

// psilocli auth validate
async function runValidate(argv) {
  const { values } = parseCommand(argv, {
    'signed-message': { type: 'string' },
    'temp-token':     { type: 'string' },
    'token-id':       { type: 'string' },
  })

  if (!values['signed-message']) fail('--signed-message is required', 2)
  if (!values['temp-token'])     fail('--temp-token is required', 2)

  const config = resolveConfig(values, { requireAuth: false })
  const sdk    = await initSdk(config)

  const result = await sdk.auth.web3AuthValidate(
    values['signed-message'],
    values['temp-token'],
    values['token-id'],
  )

  if (config.json) {
    out(result)
  } else if (result.token) {
    print(`token:      ${result.token}`)
    print(`isVerified: ${result.isVerified}`)
  } else if (result.tempToken) {
    print(`tempToken:  ${result.tempToken}`)
    print(`isVerified: ${result.isVerified}`)
    note('Wallet not yet onboarded — run "psilocli auth onboard --temp-token <token> --email <email>"')
  } else {
    fail('Unexpected response from web3/validate')
  }
}

// psilocli auth onboard
async function runOnboard(argv) {
  const { values } = parseCommand(argv, {
    'temp-token':  { type: 'string' },
    'first-name':  { type: 'string' },
    'last-name':   { type: 'string' },
    'email':       { type: 'string' },
  })

  if (!values['temp-token']) fail('--temp-token is required', 2)
  if (!values['email'])      fail('--email is required', 2)

  const config = resolveConfig(values, { requireAuth: false })
  const sdk    = await initSdk(config)

  const firstName = values['first-name'] ?? (config.address ?? 'agent')
  const lastName  = values['last-name']

  const result = await sdk.auth.web3AuthOnboard(
    values['temp-token'],
    firstName,
    lastName,
    values['email'],
  )

  if (config.json) {
    out(result)
  } else {
    print(`isVerified: ${result.isVerified}`)
    print(`timeZone:   ${result.timeZone ?? 'null'}`)
    note('Onboarding complete — run "psilocli auth validate" again to get your JWT.')
  }
}

export async function run(argv) {
  const sub = argv[0]

  const SUBS = {
    register: runRegister,
    request:  runRequest,
    validate: runValidate,
    onboard:  runOnboard,
  }

  const handler = SUBS[sub]
  if (!handler) fail(`Usage:\n${usage}`, 2)

  await handler(argv.slice(1))
}
