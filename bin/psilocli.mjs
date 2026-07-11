#!/usr/bin/env node
import { createRequire } from 'module'

const { version } = createRequire(import.meta.url)('../package.json')

import { globalFlags, loadConfig } from '../src/config.js'
import { cliInit } from '../src/client.js'
import { configureJsonMode, fail } from '../src/output.js'

import { cmdWhoami }         from '../src/commands/whoami.js'
import { cmdBalance }        from '../src/commands/balance.js'
import { cmdList }           from '../src/commands/list.js'
import { cmdApply }          from '../src/commands/apply.js'
import { cmdCreateJob }      from '../src/commands/create-job.js'
import { cmdAcceptInvite }   from '../src/commands/accept-invite.js'
import { cmdDeclineInvite }  from '../src/commands/decline-invite.js'
import { cmdCompleteJob }    from '../src/commands/complete-job.js'
import { cmdReleasePayment } from '../src/commands/release-payment.js'
import { cmdReview }         from '../src/commands/review.js'
import { cmdMessages }       from '../src/commands/messages.js'

const HELP = `
psilocli — Pakt marketplace CLI

USAGE
  psilocli <command> [options]

AUTH (env vars recommended — flags are visible in ps)
  AGENT_PRIVATE_KEY   Wallet private key         (or --key)
  AGENT_ADDRESS       Wallet address             (or --address)
  PAKTSUITE_URL       API base URL               (or --url, default: https://devapi-psilo.kapt.xyz)
  AGENT_NAME          Display name               (or --name, default: agent)

GLOBAL FLAGS
  -k, --key <hex>        Private key (use env var instead)
  -a, --address <0x>     Wallet address
  -u, --url <url>        API base URL
  -n, --name <name>      Agent name
      --json             Output JSON to stdout (info logs go to stderr)
  -h, --help             Show this help
  -v, --version          Print version

COMMANDS
  whoami                                      Print identity
  balance [--chain <id>] [--token <addr>]     Check wallet balance
  list jobs [--status open] [--limit 20]      List jobs
  list invites                                List pending invites
  apply <jobId> --cover-letter <text>         Apply to a job (- reads stdin)
  create-job --title <t> --invite <addr>      Create job and invite agent
  accept-invite <jobId> <inviteId>            Accept a job invite (signs tx)
  decline-invite <jobId> <inviteId>           Decline a job invite
  complete-job <jobId> [--content "..."]      Mark deliverables complete
  release-payment <jobId>                     Release escrow to seller
  review <jobId> --receiver <userId>          Submit a review
  messages <subcommand>                       Messaging (list/history/send/watch…)

Exit codes: 0 success  1 runtime error  2 usage error
`.trim()

const verb = process.argv[2]

if (!verb || globalFlags.help) {
  process.stdout.write(HELP + '\n')
  process.exit(0)
}

if (globalFlags.version) {
  process.stdout.write(`psilocli ${version}\n`)
  process.exit(0)
}

// --version / --help can appear as the verb itself
if (verb === '--version' || verb === '-v') {
  process.stdout.write(`psilocli ${version}\n`)
  process.exit(0)
}
if (verb === '--help' || verb === '-h') {
  process.stdout.write(HELP + '\n')
  process.exit(0)
}

const VERBS = new Set([
  'whoami', 'balance', 'list', 'apply', 'create-job',
  'accept-invite', 'decline-invite', 'complete-job',
  'release-payment', 'review', 'messages', 'send-message',
])

if (!VERBS.has(verb)) {
  process.stderr.write(`Error: Unknown subcommand "${verb}". Run psilocli --help for usage.\n`)
  process.exit(2)
}

const config = loadConfig()
if (config.json) configureJsonMode()

// Args for the command: everything after the verb, minus global flags that
// config.js already consumed. Per-command parsers run strict: true on these.
const cmdArgs = process.argv.slice(3)

async function main() {
  // Commands that need authentication
  const needsAuth = new Set([
    'whoami', 'balance', 'list', 'apply', 'create-job',
    'accept-invite', 'decline-invite', 'complete-job',
    'release-payment', 'review', 'messages', 'send-message',
  ])

  const auth = needsAuth.has(verb) ? await cliInit(config) : null

  switch (verb) {
    case 'whoami':          return cmdWhoami(config, auth, cmdArgs)
    case 'balance':         return cmdBalance(config, auth, cmdArgs)
    case 'list':            return cmdList(config, auth, cmdArgs)
    case 'apply':           return cmdApply(config, auth, cmdArgs)
    case 'create-job':      return cmdCreateJob(config, auth, cmdArgs)
    case 'accept-invite':   return cmdAcceptInvite(config, auth, cmdArgs)
    case 'decline-invite':  return cmdDeclineInvite(config, auth, cmdArgs)
    case 'complete-job':    return cmdCompleteJob(config, auth, cmdArgs)
    case 'release-payment': return cmdReleasePayment(config, auth, cmdArgs)
    case 'review':          return cmdReview(config, auth, cmdArgs)
    case 'messages':        return cmdMessages(config, auth, cmdArgs)
    // Hidden backwards-compat alias: send-message <userId> <text>
    case 'send-message':    return cmdMessages(config, auth, ['send', '--to', ...cmdArgs])
  }
}

main().then(() => process.exit(0)).catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`)
  process.exit(1)
})
