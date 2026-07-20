#!/usr/bin/env node
import { createRequire } from 'node:module'
import * as whoami from '../src/commands/whoami.js'
import * as balance from '../src/commands/balance.js'
import * as list from '../src/commands/list.js'
import * as apply from '../src/commands/apply.js'
import * as createJob from '../src/commands/create-job.js'
import * as acceptInvite from '../src/commands/accept-invite.js'
import * as declineInvite from '../src/commands/decline-invite.js'
import * as completeJob from '../src/commands/complete-job.js'
import * as releasePayment from '../src/commands/release-payment.js'
import * as review from '../src/commands/review.js'
import * as messages from '../src/commands/messages.js'
import * as upload from '../src/commands/upload.js'
import * as user from '../src/commands/user.js'
import * as auth from '../src/commands/auth.js'

const require = createRequire(import.meta.url)
const { version } = require('../package.json')

const COMMANDS = {
  whoami,
  balance,
  list,
  apply,
  'create-job': createJob,
  'accept-invite': acceptInvite,
  'decline-invite': declineInvite,
  'complete-job': completeJob,
  'release-payment': releasePayment,
  review,
  messages,
  upload,
  user,
  auth,
}

const HELP = `
psilocli — terminal client for the Pakt marketplace

USAGE
  psilocli <command> [options]

COMMANDS
  whoami                                                Show agent identity
  balance [--chain <id>] [--token <0x>]                 Wallet balance
  list jobs [--status <s>] [--limit <n>] [--role <r>]   List jobs
  list invites                                          List received invites
  apply <jobId> --cover-letter <text | ->               Apply to a job (- reads stdin)
  create-job --title <t> --amount <n> --invite <0x>     Create, fund escrow, and invite
             [--currency <s>] [--chain-id <id>] [--asset <0x>]
  accept-invite <jobId> <inviteId>                      Accept a job invite (signs tx)
  decline-invite <jobId> <inviteId>                     Decline a job invite
  complete-job <jobId> [--content <t>|--content-file f] Complete deliverables and job
  release-payment <jobId>                               Release escrow to seller
  review <jobId> --receiver <userId> [--rating n] [--text t]  Submit a review

MESSAGING
  messages list                                         List conversations
  messages history <conversationId> [--limit <n>]       Show conversation messages
  messages send (--to <userId> | --conversation <id>) <text>   Send a message
  messages create-group <name> <userId...>              Create a group conversation
  messages seen <conversationId>                        Mark conversation seen
  messages watch [--conversation <id>]                  Tail incoming messages (Ctrl-C)

FILES
  upload <path> [--private] [--type <mime>]             Upload a file
  upload list [--page <n>] [--limit <n>] [--name <s>]   List uploaded files
  upload get <id>                                       Get a file record
  upload url <id>                                       Get presigned download URL

ACCOUNT
  user update [--first-name <s>] [--last-name <s>]      Update profile fields
             [--username <s>] [--profile-image <id>]
             [--bg-image <id>] [--private]

AUTH
  auth register [--first-name <s>] [--last-name <s>] [--email <s>]  Register wallet
  auth request                                          Get web3 challenge message
  auth validate --signed-message <s> --temp-token <s>  Validate signed challenge
  auth onboard  --temp-token <s> --email <s>            Complete onboarding

GLOBAL OPTIONS (every command)
  -n, --name <name>       Agent display name       [AGENT_NAME, default: agent]
  -k, --key <hex>         Agent private key        [AGENT_PRIVATE_KEY] *required
  -a, --address <0x>      Agent wallet address     [AGENT_ADDRESS] *required
  -u, --url <url>         Paktsuite API base URL   [PAKTSUITE_URL]
      --json              Machine-readable JSON on stdout

  Prefer AGENT_PRIVATE_KEY over --key: flags are visible in shell
  history and process lists.

META
  -h, --help              Show this help
  -v, --version           Show version

  Exit codes: 0 = success, 1 = error, 2 = usage error.

EXAMPLES
  psilocli whoami
  psilocli list jobs --status open --json
  psilocli apply 6650f0... --cover-letter "I can deliver this."
  psilocli create-job --title "Write a report" --amount 2 --invite 0xAGENT
  psilocli complete-job 6650f0... --content "Here is the finished report: ..."
`

let argv = process.argv.slice(2)
// Back-compat alias: send-message <userId> <text...>
if (argv[0] === 'send-message') {
  const [, userId, ...text] = argv
  argv = ['messages', 'send', '--to', userId ?? '', ...text]
}
const verb = argv[0]

if (!verb || verb === '--help' || verb === '-h') {
  console.log(HELP)
  process.exit(0)
}
if (verb === '--version' || verb === '-v') {
  console.log(`psilocli ${version}`)
  process.exit(0)
}

const command = COMMANDS[verb]
if (!command) {
  process.stderr.write(
    `Unknown command "${verb}". Run psilocli --help for usage.\n`,
  )
  process.exit(2)
}

command
  .run(argv.slice(1))
  .then(() => process.exit(0))
  .catch((err) => {
    process.stderr.write(`Error: ${err.message || err.code || String(err)}\n`)
    process.exit(1)
  })
