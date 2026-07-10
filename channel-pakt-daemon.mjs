#!/usr/bin/env node
/**
 * channel-pakt daemon — persistent A2A bridge for Pakt platform agents
 *
 * All options can be passed as CLI flags or environment variables.
 * CLI flags take precedence over env vars.
 *
 * Run `psilocli --help` to see all options.
 */

import { execFile } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
import { promisify } from 'util'
import { parseArgs } from 'node:util'
import Anthropic from '@anthropic-ai/sdk'
import { ethers } from 'ethers'
import { PsiloSDK, MessagingService } from '@pakt/psilo'

const execFileAsync = promisify(execFile)

// Detect CLI subcommand mode before any logging or config is set up.
// Any non-flag first arg (except 'start') means one-shot CLI mode.
const _firstArg = process.argv[2] ?? ''
const _isCliMode = Boolean(
  _firstArg && !_firstArg.startsWith('-') && _firstArg !== 'start',
)

// ── CLI argument parsing ───────────────────────────────────────────────────

const { values: cli } = parseArgs({
  strict: false,
  options: {
    // Core identity
    name: { type: 'string', short: 'n' },
    key: { type: 'string', short: 'k' },
    address: { type: 'string', short: 'a' },
    url: { type: 'string', short: 'u' },
    // LLM sandbox
    sandbox: { type: 'string', short: 's' },
    'api-key': { type: 'string' },
    'auth-token': { type: 'string' },
    model: { type: 'string', short: 'm' },
    // OpenClaw backend
    'openclaw-container': { type: 'string' },
    // Hermes backend
    'hermes-url': { type: 'string' },
    // Buyer mode
    'invite-address': { type: 'string' },
    'job-title': { type: 'string' },
    'job-description': { type: 'string' },
    'job-amount': { type: 'string' },
    'job-chain-id': { type: 'string' },
    'job-asset': { type: 'string' },
    'job-deliverable': { type: 'string' },
    // Paths
    'reviewed-path': { type: 'string' },
    'applied-path': { type: 'string' },
    // Meta
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  },
})

if (cli.version) {
  console.log('psilocli 1.0.0')
  process.exit(0)
}

if (cli.help) {
  console.log(`
psilocli — Pakt A2A daemon

USAGE
  psilocli [options]
  env $(cat .env.agent-a) psilocli

CORE
  -n, --name <name>          Agent display name            [AGENT_NAME, default: agent]
  -k, --key <hex>            Agent private key             [AGENT_PRIVATE_KEY] *required
  -a, --address <0x>         Agent wallet address          [AGENT_ADDRESS] *required
  -u, --url <url>            Paktsuite API base URL        [PAKTSUITE_URL, default: https://devapi-psilo.kapt.xyz]

LLM SANDBOX
  -s, --sandbox <type>       anthropic | openclaw | hermes [SANDBOX_TYPE, default: anthropic]
      --api-key <key>        Anthropic API key             [ANTHROPIC_API_KEY]
      --auth-token <token>   Claude session token          [CLAUDE_AUTH_TOKEN]
  -m, --model <id>           Anthropic model ID            [ANTHROPIC_MODEL, default: claude-haiku-4-5-20251001]
      --openclaw-container   Docker container name         [OPENCLAW_CONTAINER]
      --hermes-url <url>     Hermes HTTP API base URL      [HERMES_URL]

BUYER MODE (creates a job and invites an agent on startup)
      --invite-address <0x>  Target agent wallet address   [INVITE_AGENT_ADDRESS]
      --job-title <text>     Job title                     [JOB_TITLE]
      --job-description <t>  Job description               [JOB_DESCRIPTION]
      --job-amount <n>       Payment amount                [JOB_AMOUNT, default: 1]
      --job-chain-id <id>    Chain ID                      [JOB_CHAIN_ID, default: 43113]
      --job-asset <0x>       ERC-20 contract (empty=native)[JOB_ASSET]
      --job-deliverable <t>  Deliverable description       [JOB_DELIVERABLE]

PATHS
      --reviewed-path <file> Reviewed-jobs dedup file      [REVIEWED_PATH]
      --applied-path <file>  Applied-jobs dedup file       [APPLIED_PATH]

META
  -h, --help                 Show this help
  -v, --version              Show version

SUBCOMMANDS  (one-shot — exits after the command completes)
  whoami                                                Show agent identity
  balance [--chain <id>] [--token <0x>]                 Wallet balance
  list jobs [--status <s>] [--limit <n>] [--role <r>]   List jobs
  list invites                                          List received invites
  apply <jobId> [--cover-letter <text>]                 Apply to a job
  create-job --title <t> --amount <n> --invite <0x>     Create and fund a job
  accept-invite <jobId> <inviteId>                      Accept a job invite
  complete-job <jobId>                                  Execute and complete a job
  release-payment <jobId>                               Release escrow to seller
  review <jobId> --receiver <userId> [--rating n] [--text t]  Submit a review
  send-message <userId> <text>                          Send a direct message

  All subcommands accept --json for machine-readable JSON output on stdout.
  Exit codes: 0 = success, 1 = error, 2 = usage error.

EXAMPLES
  # Run with flags
  psilocli --name agent-a --key 0xABC --address 0xDEF --api-key sk-ant-...

  # Run with an env file
  env $(cat .env.agent-a | xargs) psilocli

  # Buyer mode — create a job and invite agent-b
  psilocli --name agent-a --key 0x... --address 0x... \\
    --invite-address 0xAGENT_B --job-title "Write a report" --job-amount 2

  # One-shot subcommands
  psilocli whoami
  psilocli list jobs --status open --json
  psilocli apply <jobId> --cover-letter "I can deliver this."
  psilocli create-job --title "Write a report" --amount 2 --invite 0xAGENT
`)
  process.exit(0)
}

// ── Config (CLI flags take precedence over env vars) ───────────────────────

const PAKTSUITE_URL =
  cli.url ?? process.env.PAKTSUITE_URL ?? 'https://devapi-psilo.kapt.xyz'
const SANDBOX_TYPE = cli.sandbox ?? process.env.SANDBOX_TYPE ?? 'anthropic'
const agentName = cli.name ?? process.env.AGENT_NAME ?? 'agent'
const agentAddress = cli.address ?? process.env.AGENT_ADDRESS
const agentKey = cli.key ?? process.env.AGENT_PRIVATE_KEY

// Propagate LLM creds so callAnthropic() picks them up without change.
if (cli['api-key']) process.env.ANTHROPIC_API_KEY = cli['api-key']
if (cli['auth-token']) process.env.CLAUDE_AUTH_TOKEN = cli['auth-token']
if (cli.model) process.env.ANTHROPIC_MODEL = cli.model
if (cli['openclaw-container'])
  process.env.OPENCLAW_CONTAINER = cli['openclaw-container']
if (cli['hermes-url']) process.env.HERMES_URL = cli['hermes-url']

// Buyer mode: when set, this agent will create a job and invite the target agent on startup.
const INVITE_AGENT_ADDRESS =
  cli['invite-address'] ?? process.env.INVITE_AGENT_ADDRESS ?? ''
const JOB_TITLE =
  cli['job-title'] ?? process.env.JOB_TITLE ?? 'Agent-to-Agent Task'
const JOB_DESCRIPTION =
  cli['job-description'] ??
  process.env.JOB_DESCRIPTION ??
  'A task created programmatically by an agent buyer.'
const JOB_AMOUNT = cli['job-amount'] ?? process.env.JOB_AMOUNT ?? '1'
const JOB_CHAIN_ID = cli['job-chain-id'] ?? process.env.JOB_CHAIN_ID ?? '43113'
const JOB_ASSET = cli['job-asset'] ?? process.env.JOB_ASSET ?? '' // ERC-20 contract; empty = native coin
const JOB_DELIVERABLE =
  cli['job-deliverable'] ??
  process.env.JOB_DELIVERABLE ??
  'Send the buyer a message confirming job acceptance and your readiness to deliver.'

if (!agentKey) {
  console.error('--key / AGENT_PRIVATE_KEY is required')
  process.exit(1)
}
if (!agentAddress) {
  console.error('--address / AGENT_ADDRESS is required')
  process.exit(1)
}

const MAX_TURNS = 5
const TURN_RESET_MS = 120_000
const HEARTBEAT_MS = 5_000

const RPC_URLS = {
  43113: 'https://api.avax-test.network/ext/bc/C/rpc', // Avalanche Fuji testnet
  43114: 'https://api.avax.network/ext/bc/C/rpc', // Avalanche mainnet
}

const NATIVE_SYMBOLS = {
  43113: 'AVAX',
  43114: 'AVAX',
}

// ── Logging ────────────────────────────────────────────────────────────────

const _log = console.log.bind(console)
const _warn = console.warn.bind(console)
const _error = console.error.bind(console)
const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 23)
// Timestamps only in daemon mode — CLI output should be clean.
if (!_isCliMode) {
  console.log = (...a) => _log(`[${ts()}]`, ...a)
  console.warn = (...a) => _warn(`[${ts()}]`, ...a)
  console.error = (...a) => _error(`[${ts()}]`, ...a)
}

// ── SDK result unwrap ──────────────────────────────────────────────────────

function sdkOk(result, label) {
  if (!result || result.status === 'error' || !result.data) {
    throw new Error(
      `${label} failed: ${JSON.stringify(result?.message ?? result)}`,
    )
  }
  return result.data
}

// ── Persistent review dedup ────────────────────────────────────────────────

const REVIEWED_PATH =
  cli['reviewed-path'] ??
  process.env.REVIEWED_PATH ??
  `/tmp/daemon-${agentName}-reviewed.json`

function loadReviewed() {
  try {
    return new Set(JSON.parse(readFileSync(REVIEWED_PATH, 'utf8')))
  } catch {
    return new Set()
  }
}

function saveReviewed() {
  try {
    writeFileSync(REVIEWED_PATH, JSON.stringify([...reviewedJobs]))
  } catch (err) {
    console.error(`[${agentName}] Failed to persist reviewed set:`, err.message)
  }
}

const reviewedJobs = loadReviewed()
if (!_isCliMode)
  console.log(
    `[${agentName}] Loaded ${reviewedJobs.size} previously reviewed job(s) from disk`,
  )

// ── Persistent applied-jobs dedup ─────────────────────────────────────────

const APPLIED_PATH =
  cli['applied-path'] ??
  process.env.APPLIED_PATH ??
  `/tmp/daemon-${agentName}-applied.json`

function loadApplied() {
  try {
    return new Set(JSON.parse(readFileSync(APPLIED_PATH, 'utf8')))
  } catch {
    return new Set()
  }
}

function saveApplied() {
  try {
    writeFileSync(APPLIED_PATH, JSON.stringify([...appliedJobs]))
  } catch (err) {
    console.error(`[${agentName}] Failed to persist applied set:`, err.message)
  }
}

const appliedJobs = loadApplied()
if (!_isCliMode)
  console.log(
    `[${agentName}] Loaded ${appliedJobs.size} previously applied job(s) from disk`,
  )

// ── Message dedup (in-memory, 30s TTL) ────────────────────────────────────

const processed = new Set()
function markProcessed(id) {
  if (processed.has(id)) return false
  processed.add(id)
  setTimeout(() => processed.delete(id), 30_000)
  return true
}

const executingJobs = new Set()

// Prevents re-creating the buyer job on every reconnect.
let buyerJobCreated = false

// ── Turn counter ───────────────────────────────────────────────────────────

const turns = new Map()
const timers = new Map()
function checkTurns(convId) {
  const n = (turns.get(convId) ?? 0) + 1
  turns.set(convId, n)
  const t = timers.get(convId)
  if (t) clearTimeout(t)
  timers.set(
    convId,
    setTimeout(() => {
      turns.delete(convId)
      timers.delete(convId)
    }, TURN_RESET_MS),
  )
  return n <= MAX_TURNS
}

// ── JWT decode ─────────────────────────────────────────────────────────────

function decodeUserId(token) {
  const payload = JSON.parse(
    Buffer.from(token.split('.')[1], 'base64url').toString(),
  )
  return payload.id ?? payload.sub
}

// ── Blockchain tx signing ──────────────────────────────────────────────────

async function signAndBroadcast(txPayload) {
  const rpcUrl = RPC_URLS[txPayload.chainId]
  if (!rpcUrl)
    throw new Error(`No RPC URL configured for chain ${txPayload.chainId}`)
  const provider = new ethers.JsonRpcProvider(rpcUrl)
  const wallet = new ethers.Wallet(agentKey, provider)
  const tx = await wallet.sendTransaction({
    to: txPayload.to,
    data: txPayload.data,
    value: txPayload.value,
    gasLimit: txPayload.gas,
    maxFeePerGas: txPayload.maxFeePerGas,
    maxPriorityFeePerGas: txPayload.maxPriorityFeePerGas,
  })
  const receipt = await tx.wait()
  return receipt.hash
}

// ── Public job scanner (seller mode) ──────────────────────────────────────
// Periodically fetches open jobs, skips own jobs and already-applied jobs,
// and submits an LLM-generated cover letter application to each new one.

const SCAN_INTERVAL_MS = 3 * 60 * 1000 // every 3 minutes
let scanTimer = null

async function scanAndApply(sdk, currentUserId) {
  let listed
  try {
    listed = sdkOk(
      await sdk.job.list({ status: 'open', limit: 20 }),
      'job.list (scan)',
    )
  } catch (err) {
    console.error(`[${agentName}] scanAndApply — list failed:`, err.message)
    return
  }

  const jobs = listed?.data ?? []
  if (jobs.length === 0) return

  const eligible = jobs.filter((j) => {
    const jobId = String(j._id)
    const creator = String(j.creator?._id ?? j.creator ?? '')
    const receiver = String(j.receiver?._id ?? j.receiver ?? '')
    return (
      creator !== currentUserId && // not own job
      receiver !== currentUserId && // not already working it
      !appliedJobs.has(jobId)
    ) // not already applied or invited
  })

  if (eligible.length === 0) return
  console.log(
    `[${agentName}] [SCAN] ${eligible.length} open job(s) eligible for application`,
  )

  for (const job of eligible) {
    const jobId = String(job._id)

    const prompt = [
      `You are a professional autonomous agent applying for a freelance job.`,
      `Job title: "${job.title}"`,
      job.description ? `Job description: ${job.description}` : '',
      `Write a compelling, concise cover letter (2-3 sentences) explaining why you are a great fit.`,
      `Do NOT use placeholders or generic filler. Be specific to the job. Reply with the cover letter text only.`,
    ]
      .filter(Boolean)
      .join('\n')

    let coverLetter = `I am well-suited for "${job.title}" and can deliver the required work promptly and professionally. My capabilities align directly with the job requirements and I am ready to start immediately.`
    try {
      coverLetter = await generateReply(prompt)
    } catch (err) {
      console.error(
        `[${agentName}] [SCAN] Cover letter generation failed for "${job.title}", using default:`,
        err.message,
      )
    }

    try {
      const applyTimeout = new Promise((_, r) =>
        setTimeout(() => r(new Error('job.apply timed out after 30s')), 30_000),
      )
      sdkOk(
        await Promise.race([
          sdk.job.apply(jobId, { coverLetter }),
          applyTimeout,
        ]),
        'job.apply',
      )
      appliedJobs.add(jobId)
      saveApplied()
      console.log(`[${agentName}] [SCAN] Applied to "${job.title}" (${jobId})`)
    } catch (err) {
      // Any 400 is a permanent rejection — skip on future scans regardless of message
      if (
        err.message?.includes('status code 400') ||
        err.message?.includes('already applied')
      ) {
        appliedJobs.add(jobId)
        saveApplied()
      } else {
        console.error(
          `[${agentName}] [SCAN] Apply to "${job.title}" failed:`,
          err.message,
        )
      }
    }
  }
}

// ── Wallet balance ─────────────────────────────────────────────────────────
// coin is a populated BlockchainCoin document (isToken, contractAddress,
// rpcChainId, decimal, symbol) or null for a bare native-coin fallback.

async function readWalletBalance(coin, address) {
  const isToken = coin?.isToken === true
  const symbol = coin?.symbol ?? (typeof coin === 'string' ? coin : 'AVAX')
  const chainId = String(coin?.rpcChainId ?? '43113')
  const rpcUrl = RPC_URLS[chainId] ?? Object.values(RPC_URLS)[0]
  const provider = new ethers.JsonRpcProvider(rpcUrl)

  if (isToken && coin?.contractAddress) {
    const erc20 = new ethers.Contract(
      coin.contractAddress,
      ['function balanceOf(address) view returns (uint256)'],
      provider,
    )
    const raw = await erc20.balanceOf(address)
    return {
      formatted: ethers.formatUnits(raw, Number(coin.decimal ?? '18')),
      symbol,
    }
  }

  const raw = await provider.getBalance(address)
  return { formatted: ethers.formatEther(raw), symbol }
}

// Reads ERC-20 balance, symbol and decimals directly from the token contract.
// Avoids relying on the populated BlockchainCoin document being present.
async function readTokenBalance(contractAddress, chainId, address) {
  const rpcUrl = RPC_URLS[chainId] ?? Object.values(RPC_URLS)[0]
  const provider = new ethers.JsonRpcProvider(rpcUrl)
  const erc20 = new ethers.Contract(
    contractAddress,
    [
      'function balanceOf(address) view returns (uint256)',
      'function symbol() view returns (string)',
      'function decimals() view returns (uint8)',
    ],
    provider,
  )
  const [balance, symbol, decimals] = await Promise.all([
    erc20.balanceOf(address),
    erc20.symbol(),
    erc20.decimals(),
  ])
  return { formatted: ethers.formatUnits(balance, Number(decimals)), symbol }
}

// ── Sandbox backends ───────────────────────────────────────────────────────

async function callAnthropic(message) {
  const clientOpts = process.env.ANTHROPIC_API_KEY
    ? { apiKey: process.env.ANTHROPIC_API_KEY }
    : { authToken: process.env.CLAUDE_AUTH_TOKEN }
  if (!clientOpts.apiKey && !clientOpts.authToken) {
    throw new Error(
      'ANTHROPIC_API_KEY or CLAUDE_AUTH_TOKEN is required for anthropic sandbox',
    )
  }
  const client = new Anthropic(clientOpts)
  const model = process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001'

  for (let attempt = 0; attempt <= 4; attempt++) {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: 1024,
        messages: [{ role: 'user', content: message }],
      })
      return response.content?.[0]?.text ?? 'I was unable to generate a reply.'
    } catch (err) {
      const status = err?.status ?? err?.statusCode
      if (status === 429 && attempt < 4) {
        const delay = Math.min(2000 * 2 ** attempt, 30_000)
        console.log(
          `[${agentName}] Rate limited — retrying in ${delay}ms (attempt ${attempt + 1}/4)`,
        )
        await new Promise((r) => setTimeout(r, delay))
        continue
      }
      throw err
    }
  }
}

// Serialize all openclaw calls — concurrent docker execs share the same session file
// and cause EmbeddedAttemptSessionTakeoverError.
let _openClawQueue = Promise.resolve()

async function callOpenClaw(message) {
  const run = async () => {
    const container = process.env.OPENCLAW_CONTAINER
    if (!container)
      throw new Error('OPENCLAW_CONTAINER is required for openclaw sandbox')
    const args = [
      'exec',
      '-e',
      'OPENCLAW_CHANNEL_PAKT_DISABLE=1',
      container,
      'openclaw',
      'agent',
      '--message',
      message,
      '--agent',
      'main',
      '--json',
      '--local',
    ]
    if (process.env.OPENCLAW_LOCAL_MODEL)
      args.push('--model', process.env.OPENCLAW_LOCAL_MODEL)
    const { stdout, stderr } = await execFileAsync('docker', args, {
      timeout: 90_000,
    })
    const output = stdout || stderr
    let parsed
    try {
      parsed = JSON.parse(output)
    } catch {
      parsed = null
    }
    return (
      parsed?.result?.payloads?.[0]?.text ??
      parsed?.result?.payloads?.[0]?.content ??
      parsed?.payloads?.[0]?.text ??
      parsed?.payloads?.[0]?.content ??
      parsed?.text ??
      parsed?.content ??
      output.slice(0, 500)
    )
  }
  const next = _openClawQueue.then(run, run)
  _openClawQueue = next.catch(() => {})
  return next
}

async function callHermes(message) {
  const hermesUrl = process.env.HERMES_URL
  if (!hermesUrl) throw new Error('HERMES_URL is required for hermes sandbox')
  const res = await fetch(`${hermesUrl}/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  })
  if (!res.ok)
    throw new Error(`Hermes responded ${res.status}: ${await res.text()}`)
  const json = await res.json()
  return json?.text ?? json?.content ?? json?.reply ?? JSON.stringify(json)
}

async function generateReply(message) {
  switch (SANDBOX_TYPE) {
    case 'anthropic':
      return callAnthropic(message)
    case 'openclaw':
      return callOpenClaw(message)
    case 'hermes':
      return callHermes(message)
    default:
      throw new Error(
        `Unknown SANDBOX_TYPE "${SANDBOX_TYPE}" — must be anthropic | openclaw | hermes`,
      )
  }
}

// ── Buyer: resolve address → user ID ──────────────────────────────────────

async function resolveUserIdByAddress(address) {
  const res = await fetch(
    `${PAKTSUITE_URL}/v1/account-public/by-wallet/${encodeURIComponent(address)}`,
  )
  if (!res.ok) throw new Error(`by-wallet lookup failed: ${res.status}`)
  const body = await res.json()
  const userId = body?.data?._id ?? body?._id
  if (!userId) throw new Error(`No user found for address ${address}`)
  return String(userId)
}

// ── Buyer: create job + invite ─────────────────────────────────────────────

async function createJobAndInvite(sdk, inviteeAddress, params = {}) {
  const jobTitle = params.title ?? JOB_TITLE
  const jobDescription = params.description ?? JOB_DESCRIPTION
  const jobAmount = params.amount ?? JOB_AMOUNT
  const jobChainId = params.chainId ?? JOB_CHAIN_ID
  const jobAsset = params.asset ?? JOB_ASSET
  const jobDeliverable = params.deliverable ?? JOB_DELIVERABLE

  console.log(
    `[${agentName}] Resolving user ID for invitee address: ${inviteeAddress}`,
  )
  const inviteeUserId = await resolveUserIdByAddress(inviteeAddress)
  console.log(`[${agentName}] Invitee user ID: ${inviteeUserId}`)

  const deliverables = jobDeliverable ? [{ name: jobDeliverable }] : []

  const createDto = {
    title: jobTitle,
    description: jobDescription,
    amount: jobAmount,
    chainId: jobChainId,
    ...(jobAsset ? { asset: jobAsset } : {}),
    deliverables,
  }

  // ── Step 1: Create job record ──────────────────────────────────────────────
  console.log(`[${agentName}] Creating job: "${jobTitle}"`)
  const createData = sdkOk(await sdk.job.create(createDto), 'job.create')
  const job = createData?.job ?? createData
  const jobId = String(job._id)
  console.log(`[${agentName}] Job created — jobId: ${jobId}`)

  // ── Step 2: Prepare escrow deposit ────────────────────────────────────────
  // Server creates the escrow on-chain (arbiter key), returns deposit + approve txs.
  console.log(`[${agentName}] Calling makeDeposit to prepare escrow...`)
  const depositData = sdkOk(await sdk.job.makeDeposit(jobId), 'makeDeposit')
  console.log(
    `[${agentName}] Escrow address: ${depositData?.escrowAddress} — amount: ${depositData?.coinAmount} ${depositData?.coinSymbol}`,
  )

  // ── Step 3: Sign approve tx (ERC-20 only) ────────────────────────────────
  if (depositData?.approve) {
    console.log(`[${agentName}] Signing ERC-20 approve tx...`)
    const approveTx = {
      ...depositData.approve,
      chainId: depositData.approve.chainId ?? depositData.chainId,
    }
    const approveTxHash = await signAndBroadcast(approveTx)
    console.log(
      `[${agentName}] Approve tx broadcast — txHash: ${approveTxHash}`,
    )
    // Wait for approve to be mined before depositing.
    await new Promise((r) => setTimeout(r, 8_000))
  }

  // ── Step 4: Sign deposit tx ───────────────────────────────────────────────
  if (depositData?.deposit) {
    console.log(`[${agentName}] Signing deposit tx...`)
    const depositTx = {
      ...depositData.deposit,
      chainId: depositData.deposit.chainId ?? depositData.chainId,
    }
    const depositTxHash = await signAndBroadcast(depositTx)
    console.log(
      `[${agentName}] Deposit tx broadcast — txHash: ${depositTxHash} — waiting for confirmation...`,
    )
    await new Promise((r) => setTimeout(r, 12_000))
  }

  // ── Step 5: Validate payment on-chain ────────────────────────────────────
  // Retries in case the deposit tx hasn't been indexed yet.
  let validated = false
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      sdkOk(await sdk.job.validatePayment(jobId), 'validatePayment')
      validated = true
      console.log(
        `[${agentName}] Escrow funded and validated (attempt ${attempt})`,
      )
      break
    } catch (err) {
      console.log(
        `[${agentName}] validatePayment attempt ${attempt}/6 failed: ${err.message}`,
      )
      if (attempt < 6) await new Promise((r) => setTimeout(r, 10_000))
    }
  }
  if (!validated) {
    throw new Error(
      'Escrow deposit could not be confirmed after 6 attempts — aborting invite',
    )
  }

  // ── Step 6: Send invite ───────────────────────────────────────────────────
  console.log(
    `[${agentName}] Inviting ${inviteeAddress} (userId: ${inviteeUserId}) to job ${jobId}...`,
  )
  const inviteData = sdkOk(
    await sdk.job.inviteTalent(jobId, { inviteeId: inviteeUserId }),
    'inviteTalent',
  )

  // Sign the invite tx if required (escrow-locked invites).
  if (inviteData?.invitePayload) {
    const tx = inviteData.invitePayload
    console.log(`[${agentName}] Signing onInvite tx for chain ${tx.chainId}...`)
    const txHash = await signAndBroadcast(tx)
    sdkOk(
      await sdk.job.confirmTx(jobId, {
        step: 'onInvite',
        txHash,
        inviteeId: inviteeUserId,
      }),
      'confirmTx onInvite',
    )
    console.log(`[${agentName}] confirmTx onInvite — txHash: ${txHash}`)
  }

  console.log(
    `[${agentName}] Invite sent to ${inviteeAddress} for job "${jobTitle}" (${jobId})`,
  )
  return { jobId, inviteeAddress, inviteeUserId }
}

// ── Job execution ──────────────────────────────────────────────────────────

function isMessagingDeliverable(deliverable) {
  const text =
    `${deliverable.title ?? ''} ${deliverable.description ?? ''}`.toLowerCase()
  return (
    (text.includes('send') && text.includes('message')) ||
    (text.includes('conversation') && text.includes('message')) ||
    text.includes('message the buyer') ||
    text.includes('message the creator') ||
    text.includes('message buyer') ||
    text.includes('message creator') ||
    text.includes('introduce yourself') ||
    text.includes('introduction message')
  )
}

async function executeJob(sdk, messaging, jobId) {
  if (executingJobs.has(jobId)) {
    console.log(
      `[${agentName}] executeJob: already processing job ${jobId} — skipping duplicate`,
    )
    return
  }
  executingJobs.add(jobId)
  try {
    await _runJob(sdk, messaging, jobId)
  } finally {
    executingJobs.delete(jobId)
  }
}

async function _runJob(sdk, messaging, jobId) {
  console.log(`[${agentName}] Starting job execution — jobId: ${jobId}`)

  let job
  try {
    const jobData = sdkOk(await sdk.job.getById(jobId), 'getById')
    job = jobData?.job ?? jobData
  } catch (err) {
    console.error(`[${agentName}] executeJob: getById failed:`, err.message)
    return
  }

  const jobSeller = (job.seller ?? '').toLowerCase()
  if (jobSeller && jobSeller !== agentAddress.toLowerCase()) {
    console.log(
      `[${agentName}] Skipping job "${job.title}" — not the seller (seller: ${jobSeller})`,
    )
    return
  }

  const allDeliverables = job.deliverables ?? []
  const pending = allDeliverables.filter((d) => d.status !== 'completed')
  console.log(
    `[${agentName}] Job "${job.title}" — ${pending.length}/${allDeliverables.length} deliverable(s) pending`,
  )

  for (const deliverable of pending) {
    const taskText = [
      `You are working on a job titled: "${job.title}"`,
      `Job description: ${job.description || '(none)'}`,
      `\nDeliverable to complete: "${deliverable.title}"`,
      deliverable.description
        ? `Deliverable details: ${deliverable.description}`
        : '',
      `\nPlease provide a thorough response that fulfills this deliverable.`,
    ]
      .filter(Boolean)
      .join('\n')

    console.log(`[${agentName}] Working on deliverable: "${deliverable.title}"`)

    let response
    try {
      response = await generateReply(taskText)
    } catch (err) {
      console.error(
        `[${agentName}] Deliverable LLM failed for "${deliverable.title}":`,
        err.message,
      )
      continue
    }

    console.log(`[${agentName}] Response (preview): ${response?.slice(0, 120)}`)

    // If the deliverable asks to message the buyer, send the reply via chat.
    // messaging may be null in CLI mode — skip gracefully.
    if (isMessagingDeliverable(deliverable) && messaging) {
      const creatorId = String(job.creator?._id ?? job.creator ?? '')
      if (creatorId) {
        try {
          const convo = await Promise.race([
            messaging.createDirectConversation(creatorId),
            new Promise((_, reject) =>
              setTimeout(
                () =>
                  reject(
                    new Error('createDirectConversation timed out after 10s'),
                  ),
                10_000,
              ),
            ),
          ])
          messaging.sendMessage({
            conversationId: convo._id,
            type: 'TEXT',
            message: response,
          })
          console.log(
            `[${agentName}] Message sent to creator in conversation ${convo._id}`,
          )
        } catch (err) {
          console.error(
            `[${agentName}] Failed to send message to creator:`,
            err.message,
          )
        }
      } else {
        console.warn(
          `[${agentName}] Messaging deliverable but creator ID unknown — skipping send`,
        )
      }
    }

    try {
      sdkOk(
        await sdk.job.toggleDeliverableProgress(
          jobId,
          String(deliverable._id),
          { status: 'completed' },
        ),
        'toggleDeliverableProgress',
      )
      console.log(
        `[${agentName}] Deliverable "${deliverable.title}" marked complete`,
      )
    } catch (err) {
      console.error(
        `[${agentName}] Failed to mark deliverable complete:`,
        err.message,
      )
    }
  }

  const refreshed = sdkOk(
    await sdk.job.getById(jobId),
    'getById (pre-complete check)',
  )
  const refreshedJob = refreshed?.job ?? refreshed
  const stillPending = (refreshedJob?.deliverables ?? []).filter(
    (d) => d.status !== 'completed',
  )
  if (stillPending.length > 0) {
    console.error(
      `[${agentName}] ${stillPending.length} deliverable(s) still incomplete — skipping completeJob`,
    )
    return
  }

  console.log(
    `[${agentName}] All deliverables confirmed complete — completing job`,
  )

  let completeData
  try {
    completeData = sdkOk(await sdk.job.completeJob(jobId, {}), 'completeJob')
  } catch (err) {
    console.error(`[${agentName}] completeJob failed:`, err.message)
    return
  }

  const { markReadyPayload } = completeData
  if (markReadyPayload) {
    console.log(
      `[${agentName}] Signing markReady tx for chain ${markReadyPayload.chainId}...`,
    )
    try {
      const txHash = await signAndBroadcast(markReadyPayload)
      console.log(
        `[${agentName}] markReady broadcast — txHash: ${txHash} — waiting for confirmation...`,
      )

      let confirmed = false
      for (let attempt = 1; attempt <= 6; attempt++) {
        await new Promise((r) => setTimeout(r, 10_000))
        try {
          sdkOk(
            await sdk.job.confirmTx(jobId, { step: 'onMarkReady', txHash }),
            'confirmTx onMarkReady',
          )
          console.log(
            `[${agentName}] Job marked ready on-chain (attempt ${attempt}) — txHash: ${txHash}`,
          )
          confirmed = true
          break
        } catch (err) {
          console.log(
            `[${agentName}] confirmTx onMarkReady attempt ${attempt}/6 failed: ${err.message}`,
          )
        }
      }
      if (!confirmed) {
        console.error(
          `[${agentName}] confirmTx onMarkReady exhausted retries — buyer cannot release until daemon restarts`,
        )
      }
    } catch (err) {
      console.error(`[${agentName}] markReady signing failed:`, err.message)
    }
  } else {
    console.log(`[${agentName}] Job completed (off-chain)`)
  }

  console.log(
    `[${agentName}] Awaiting buyer payment release — review will be submitted on next connect`,
  )
}

// ── Post-job review ────────────────────────────────────────────────────────

async function reviewCompletedJobs(sdk) {
  const listResult = await sdk.job.list({
    status: 'completed',
    role: 'seller',
    limit: 20,
  })
  const jobs = listResult.data?.data ?? listResult.data?.jobs ?? []

  const mine = jobs.filter(
    (j) => (j.seller ?? '').toLowerCase() === agentAddress.toLowerCase(),
  )
  if (mine.length === 0) return

  console.log(`[${agentName}] Found ${mine.length} completed job(s) to review`)

  for (const j of mine) {
    const jobId = String(j._id)
    if (reviewedJobs.has(jobId)) continue

    const buyerId = String(j.creator?._id ?? j.creator ?? '')
    if (!buyerId) {
      console.log(
        `[${agentName}] Skipping review for "${j.title}" — buyer ID unknown`,
      )
      continue
    }

    const prompt = [
      `You just completed a freelance job titled: "${j.title}"`,
      j.description ? `Job description: ${j.description}` : '',
      `Write a short professional review of the buyer (1-2 sentences) and give a star rating 1-5.`,
      `Reply ONLY with valid JSON: {"rating": <number 1-5>, "review": "<text>"}`,
    ]
      .filter(Boolean)
      .join('\n')

    let rating = 5
    let review =
      'Great experience. Clear requirements and smooth collaboration throughout.'
    try {
      const raw = await generateReply(prompt)
      console.log(`[${agentName}] Review LLM raw: ${raw?.slice(0, 200)}`)
      const match = raw.match(/\{[\s\S]*?\}/)
      if (match) {
        const parsed = JSON.parse(match[0])
        if (
          Number.isInteger(parsed.rating) &&
          parsed.rating >= 1 &&
          parsed.rating <= 5
        )
          rating = parsed.rating
        if (parsed.review) review = parsed.review
      }
    } catch (err) {
      console.log(
        `[${agentName}] Review generation failed, using default:`,
        err.message,
      )
    }

    console.log(
      `[${agentName}] Submitting review for "${j.title}" — ${rating}/5 — receiverId: ${buyerId}`,
    )
    console.log(`[${agentName}] Review text: ${review}`)
    try {
      const reviewData = sdkOk(
        await sdk.job.submitReview(jobId, {
          receiverId: buyerId,
          review,
          rating,
        }),
        'submitReview',
      )
      reviewedJobs.add(jobId)
      saveReviewed()
      console.log(
        `[${agentName}] Review submitted for "${j.title}" — id: ${reviewData?._id}`,
      )
    } catch (err) {
      console.error(
        `[${agentName}] submitReview failed for "${j.title}":`,
        err.message,
      )
    }
  }
}

// ── Job invite handler ─────────────────────────────────────────────────────

async function handleJobInvite(sdk, messaging, invite) {
  const { jobId, jobTitle, senderId, inviteId } = invite
  console.log(
    `[${agentName}] JOB_INVITE received — job: ${jobTitle} (${jobId}), inviteId: ${inviteId}`,
  )

  const prompt = `You have received a job invite.\nJob title: "${jobTitle}"\nJob ID: ${jobId}\nFrom user: ${senderId}\n\nShould you accept or decline this invite? Reply with exactly one word: "accept" or "decline".`

  let decision
  try {
    const raw = await generateReply(prompt)
    decision = raw.trim().toLowerCase().startsWith('accept')
      ? 'accept'
      : 'decline'
  } catch (err) {
    console.error(
      `[${agentName}] Job invite reasoning failed, defaulting to decline:`,
      err.message,
    )
    decision = 'decline'
  }

  console.log(`[${agentName}] Decision for invite ${inviteId}: ${decision}`)

  try {
    if (decision === 'decline') {
      await sdk.job.declineInvite(jobId, inviteId)
      console.log(`[${agentName}] Declined job invite ${inviteId}`)
      return
    }

    const acceptData = sdkOk(
      await sdk.job.acceptInvite(jobId, inviteId),
      'acceptInvite',
    )
    console.log(
      `[${agentName}] Accepted job invite ${inviteId} — acceptPayload present: ${!!acceptData?.acceptPayload}`,
    )

    if (acceptData?.acceptPayload) {
      console.log(
        `[${agentName}] Signing acceptPayload for chain ${acceptData.acceptPayload.chainId}...`,
      )
      const txHash = await signAndBroadcast(acceptData.acceptPayload)
      sdkOk(
        await sdk.job.confirmTx(jobId, { step: 'onAccept', txHash }),
        'confirmTx onAccept',
      )
      console.log(`[${agentName}] confirmTx onAccept — txHash: ${txHash}`)
    } else {
      console.log(
        `[${agentName}] No on-chain accept needed — invite accepted off-chain`,
      )
    }

    executeJob(sdk, messaging, jobId).catch((err) =>
      console.error(`[${agentName}] executeJob failed:`, err.message),
    )
  } catch (err) {
    console.error(`[${agentName}] handleJobInvite failed:`, err.message)
  }
}

// ── CLI subcommands ────────────────────────────────────────────────────────

const CLI_VERBS = new Set([
  'whoami',
  'balance',
  'list',
  'apply',
  'create-job',
  'accept-invite',
  'complete-job',
  'release-payment',
  'review',
  'send-message',
])

async function cliInit() {
  const sdk = await PsiloSDK.init({ baseUrl: PAKTSUITE_URL })
  const jwt = await sdk.auth.paktWeb3Login(agentKey)
  const userId = decodeUserId(jwt)
  sdk.setAuthorizationHeader(jwt)
  return { sdk, userId, jwt }
}

function cliTable(rows, headers) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)),
  )
  const fmt = (cells) =>
    cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ')
  _log(fmt(headers))
  _log(widths.map((w) => '-'.repeat(w)).join('  '))
  for (const row of rows) _log(fmt(row))
}

async function runCLI() {
  const verb = process.argv[2]
  const isJson = process.argv.includes('--json')

  // In JSON mode redirect informational console.log to stderr so stdout is pure JSON.
  if (isJson) console.log = console.error

  function out(data) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n')
  }
  function fail(msg, code = 1) {
    process.stderr.write(`Error: ${msg}\n`)
    process.exit(code)
  }

  if (!CLI_VERBS.has(verb)) {
    fail(`Unknown subcommand "${verb}". Run psilocli --help for usage.`, 2)
  }

  const { sdk, userId, jwt } = await cliInit()

  // ── whoami ─────────────────────────────────────────────────────────────────
  if (verb === 'whoami') {
    const data = { name: agentName, address: agentAddress, userId }
    if (isJson) {
      out(data)
    } else {
      _log(`Name:    ${data.name}`)
      _log(`Address: ${data.address}`)
      _log(`User ID: ${data.userId}`)
    }
    return
  }

  // ── balance ────────────────────────────────────────────────────────────────
  if (verb === 'balance') {
    const { values: flags } = parseArgs({
      args: process.argv.slice(3),
      options: {
        chain: { type: 'string' },
        token: { type: 'string' },
      },
      strict: false,
    })
    const chainId = flags.chain ?? '43113'
    const rpcUrl = RPC_URLS[chainId]
    if (!rpcUrl) fail(`No RPC URL configured for chain ${chainId}`)
    const provider = new ethers.JsonRpcProvider(rpcUrl)
    const raw = await provider.getBalance(agentAddress)
    const result = {
      native: {
        chain: chainId,
        symbol: NATIVE_SYMBOLS[chainId] ?? 'native',
        balance: ethers.formatEther(raw),
      },
    }
    if (flags.token) {
      const { formatted, symbol } = await readTokenBalance(
        flags.token,
        chainId,
        agentAddress,
      )
      result.token = { address: flags.token, symbol, balance: formatted }
    }
    if (isJson) {
      out(result)
    } else {
      _log(`${result.native.symbol}: ${result.native.balance}`)
      if (result.token)
        _log(
          `${result.token.symbol} (${result.token.address}): ${result.token.balance}`,
        )
    }
    return
  }

  // ── list jobs / list invites ───────────────────────────────────────────────
  if (verb === 'list') {
    const sub = process.argv[3]

    if (sub === 'jobs') {
      const { values: flags } = parseArgs({
        args: process.argv.slice(4),
        options: {
          status: { type: 'string' },
          limit: { type: 'string' },
          role: { type: 'string' },
        },
        strict: false,
      })
      const status = flags.status ?? 'open'
      const limit = parseInt(flags.limit ?? '20', 10)
      const listOpts = {
        status,
        limit,
        ...(flags.role ? { role: flags.role } : {}),
      }
      const result = sdkOk(await sdk.job.list(listOpts), 'job.list')
      const jobs = result?.data ?? (Array.isArray(result) ? result : [])
      if (isJson) {
        out(jobs)
      } else if (jobs.length === 0) {
        _log('No jobs found.')
      } else {
        cliTable(
          jobs.map((j) => [
            String(j._id).slice(-8),
            (j.title ?? '').slice(0, 40),
            j.status ?? '',
            String(j.amount ?? ''),
            j.currency?.symbol ?? 'AVAX',
          ]),
          ['ID', 'Title', 'Status', 'Amount', 'Token'],
        )
      }
      return
    }

    if (sub === 'invites') {
      const { data: inviteList } = await sdk.job.listAllInvites()
      const invites = inviteList?.data ?? []
      if (isJson) {
        out(invites)
      } else if (invites.length === 0) {
        _log('No invites found.')
      } else {
        cliTable(
          invites.map((i) => [
            String(i._id).slice(-8),
            (i.job?.title ?? '').slice(0, 40),
            i.direction ?? '',
            i.status ?? '',
            String(i.sender?._id ?? '').slice(-8),
          ]),
          ['ID', 'Job Title', 'Dir', 'Status', 'From'],
        )
      }
      return
    }

    process.stderr.write('Usage: psilocli list jobs | psilocli list invites\n')
    process.exit(2)
  }

  // ── apply ──────────────────────────────────────────────────────────────────
  if (verb === 'apply') {
    const { values: flags, positionals } = parseArgs({
      args: process.argv.slice(3),
      options: { 'cover-letter': { type: 'string' } },
      allowPositionals: true,
      strict: false,
    })
    const jobId = positionals[0]
    if (!jobId) fail('Usage: psilocli apply <jobId> [--cover-letter "..."]', 2)
    const coverLetter =
      flags['cover-letter'] ??
      'I am well-suited for this role and ready to deliver promptly and professionally.'
    const applyTimeout = new Promise((_, r) =>
      setTimeout(() => r(new Error('apply timed out after 30s')), 30_000),
    )
    const data = sdkOk(
      await Promise.race([sdk.job.apply(jobId, { coverLetter }), applyTimeout]),
      'job.apply',
    )
    if (isJson) out({ ok: true, jobId, data })
    else _log(`Applied to job ${jobId}`)
    return
  }

  // ── create-job ─────────────────────────────────────────────────────────────
  if (verb === 'create-job') {
    const { values: flags } = parseArgs({
      args: process.argv.slice(3),
      options: {
        title: { type: 'string' },
        description: { type: 'string' },
        amount: { type: 'string' },
        'chain-id': { type: 'string' },
        asset: { type: 'string' },
        deliverable: { type: 'string' },
        invite: { type: 'string' },
      },
      strict: false,
    })
    const inviteeAddress = flags.invite ?? INVITE_AGENT_ADDRESS
    if (!inviteeAddress)
      fail('--invite <address> is required (or set INVITE_AGENT_ADDRESS)', 2)
    const title = flags.title ?? JOB_TITLE
    if (!title) fail('--title is required (or set JOB_TITLE)', 2)
    const result = await createJobAndInvite(sdk, inviteeAddress, {
      title: title,
      description: flags.description,
      amount: flags.amount,
      chainId: flags['chain-id'],
      asset: flags.asset,
      deliverable: flags.deliverable,
    })
    if (isJson) out({ ok: true, ...result })
    return
  }

  // ── accept-invite ──────────────────────────────────────────────────────────
  if (verb === 'accept-invite') {
    const { positionals } = parseArgs({
      args: process.argv.slice(3),
      options: {},
      allowPositionals: true,
      strict: false,
    })
    const [jobId, inviteId] = positionals
    if (!jobId || !inviteId)
      fail('Usage: psilocli accept-invite <jobId> <inviteId>', 2)
    const acceptData = sdkOk(
      await sdk.job.acceptInvite(jobId, inviteId),
      'acceptInvite',
    )
    let txHash = null
    if (acceptData?.acceptPayload) {
      txHash = await signAndBroadcast(acceptData.acceptPayload)
      sdkOk(
        await sdk.job.confirmTx(jobId, { step: 'onAccept', txHash }),
        'confirmTx onAccept',
      )
    }
    if (isJson) out({ ok: true, jobId, inviteId, txHash })
    else
      _log(
        txHash
          ? `Accepted invite ${inviteId} — txHash: ${txHash}`
          : `Accepted invite ${inviteId} (off-chain)`,
      )
    return
  }

  // ── complete-job ───────────────────────────────────────────────────────────
  // Runs full LLM execution. Messaging deliverables are skipped (no WebSocket in CLI mode).
  if (verb === 'complete-job') {
    const { positionals } = parseArgs({
      args: process.argv.slice(3),
      options: {},
      allowPositionals: true,
      strict: false,
    })
    const jobId = positionals[0]
    if (!jobId) fail('Usage: psilocli complete-job <jobId>', 2)
    await executeJob(sdk, null, jobId)
    if (isJson) out({ ok: true, jobId })
    else _log(`Job ${jobId} complete`)
    return
  }

  // ── release-payment ────────────────────────────────────────────────────────
  if (verb === 'release-payment') {
    const { positionals } = parseArgs({
      args: process.argv.slice(3),
      options: {},
      allowPositionals: true,
      strict: false,
    })
    const jobId = positionals[0]
    if (!jobId) fail('Usage: psilocli release-payment <jobId>', 2)
    const releaseData = sdkOk(
      await sdk.job.releasePayment(jobId),
      'releasePayment',
    )
    const releasePayload = releaseData?.releasePayload
    if (!releasePayload)
      fail('No releasePayload returned — job may not be in review status')
    const txHash = await signAndBroadcast(releasePayload)
    await new Promise((r) => setTimeout(r, 8_000))
    sdkOk(
      await sdk.job.confirmTx(jobId, { step: 'onRelease', txHash }),
      'confirmTx onRelease',
    )
    if (isJson) out({ ok: true, jobId, txHash })
    else _log(`Payment released — txHash: ${txHash}`)
    return
  }

  // ── review ─────────────────────────────────────────────────────────────────
  if (verb === 'review') {
    const { values: flags, positionals } = parseArgs({
      args: process.argv.slice(3),
      options: {
        receiver: { type: 'string' },
        rating: { type: 'string' },
        text: { type: 'string' },
      },
      allowPositionals: true,
      strict: false,
    })
    const jobId = positionals[0]
    if (!jobId)
      fail(
        'Usage: psilocli review <jobId> --receiver <userId> [--rating 1-5] [--text "..."]',
        2,
      )
    const receiverId = flags.receiver
    if (!receiverId) fail('--receiver <userId> is required', 2)
    const rating = Math.min(5, Math.max(1, parseInt(flags.rating ?? '5', 10)))
    const review = flags.text ?? 'Great experience. Delivered as promised.'
    const reviewData = sdkOk(
      await sdk.job.submitReview(jobId, { receiverId, review, rating }),
      'submitReview',
    )
    if (isJson) out({ ok: true, reviewId: reviewData?._id })
    else _log(`Review submitted — ${rating}/5 — id: ${reviewData?._id}`)
    return
  }

  // ── send-message ───────────────────────────────────────────────────────────
  if (verb === 'send-message') {
    const { positionals } = parseArgs({
      args: process.argv.slice(3),
      options: {},
      allowPositionals: true,
      strict: false,
    })
    const receiverId = positionals[0]
    const text = positionals.slice(1).join(' ')
    if (!receiverId || !text)
      fail('Usage: psilocli send-message <userId> <text>', 2)
    const messaging = new MessagingService(PAKTSUITE_URL, jwt)
    await messaging.connect()
    const convo = await Promise.race([
      messaging.createDirectConversation(receiverId),
      new Promise((_, r) =>
        setTimeout(
          () => r(new Error('createDirectConversation timed out')),
          10_000,
        ),
      ),
    ])
    messaging.sendMessage({
      conversationId: convo._id,
      type: 'TEXT',
      message: text,
    })
    await new Promise((r) => setTimeout(r, 1_500))
    try {
      messaging.disconnect()
    } catch {}
    if (isJson) out({ ok: true, conversationId: convo._id })
    else _log(`Message sent (conversation: ${convo._id})`)
    return
  }

  fail(`Unhandled subcommand "${verb}"`, 2)
}

// ── Main loop (auto-reconnect) ─────────────────────────────────────────────

async function run() {
  console.log(
    `[${agentName}] Starting — sandbox: ${SANDBOX_TYPE} — address: ${agentAddress}`,
  )

  while (true) {
    try {
      const sdk = await PsiloSDK.init({ baseUrl: PAKTSUITE_URL })
      const jwt = await sdk.auth.paktWeb3Login(agentKey)
      const userId = decodeUserId(jwt)
      sdk.setAuthorizationHeader(jwt)
      console.log(`[${agentName}] Authenticated — user ID: ${userId}`)

      const messaging = new MessagingService(PAKTSUITE_URL, jwt)
      await messaging.connect()
      console.log(
        `[${agentName}] Connected to paktsuite — listening for messages`,
      )

      // Register all real-time handlers before startup polls so no event is
      // dropped during the time the polls are running.
      messaging.onJobInvite((invite) => {
        const inviteJobId = invite?.jobId ?? invite?.data?.jobId
        console.log(
          `[${agentName}] [WS] onJobInvite fired — inviteId: ${invite?.inviteId} jobId: ${inviteJobId}`,
        )
        // Mark this job so the scan loop doesn't also apply to it.
        if (inviteJobId) {
          appliedJobs.add(String(inviteJobId))
          saveApplied()
        }
        handleJobInvite(sdk, messaging, invite).catch((err) =>
          console.error(
            `[${agentName}] handleJobInvite uncaught:`,
            err.message,
          ),
        )
      })

      messaging.onPaymentReleased(async (event) => {
        const jobId = event?.jobId ?? event?.data?.jobId
        const jobTitle = event?.jobTitle ?? event?.data?.jobTitle ?? jobId
        const amount = event?.amount ?? event?.data?.amount
        const txHash =
          event?.escrowReleaseTxHash ?? event?.data?.escrowReleaseTxHash

        console.log(
          `[${agentName}] [WS] PAYMENT RELEASED — "${jobTitle}" — ${amount}`,
        )
        if (txHash) console.log(`[${agentName}] [WS] Release tx: ${txHash}`)

        if (!jobId) return

        // Fetch full job to get the token contract address and chain.
        let job = null
        try {
          const jobData = sdkOk(
            await sdk.job.getById(jobId),
            'getById (payment check)',
          )
          job = jobData?.job ?? jobData
        } catch (err) {
          console.error(
            `[${agentName}] [WS] Could not fetch job for balance check:`,
            err.message,
          )
        }

        const asset = job?.asset ?? ''
        const chainId = String(job?.escrowChainId ?? '43113')

        // Token balance — read directly from the ERC-20 contract on the job's chain.
        if (asset && asset !== '0x0000000000000000000000000000000000000000') {
          try {
            const { formatted, symbol } = await readTokenBalance(
              asset,
              chainId,
              agentAddress,
            )
            console.log(
              `[${agentName}] [WS] Token balance after release: ${formatted} ${symbol} (contract: ${asset})`,
            )
          } catch (err) {
            console.error(
              `[${agentName}] [WS] Token balance check failed:`,
              err.message,
            )
          }
        }

        // Native coin balance always
        try {
          const rpcUrl = RPC_URLS[chainId] ?? Object.values(RPC_URLS)[0]
          const provider = new ethers.JsonRpcProvider(rpcUrl)
          const raw = await provider.getBalance(agentAddress)
          const nativeSym = NATIVE_SYMBOLS[chainId] ?? 'native'
          console.log(
            `[${agentName}] [WS] Wallet balance after release: ${ethers.formatEther(raw)} ${nativeSym}`,
          )
        } catch (err) {
          console.error(
            `[${agentName}] [WS] Native balance check failed:`,
            err.message,
          )
        }

        // Submit review for the buyer immediately on payment release
        if (job && !reviewedJobs.has(jobId)) {
          const buyerId = String(job.creator?._id ?? job.creator ?? '')
          if (buyerId) {
            const prompt = [
              `You just completed a freelance job titled: "${job.title}"`,
              job.description ? `Job description: ${job.description}` : '',
              `Write a short professional review of the buyer (1-2 sentences) and give a star rating 1-5.`,
              `Reply ONLY with valid JSON: {"rating": <number 1-5>, "review": "<text>"}`,
            ]
              .filter(Boolean)
              .join('\n')

            let rating = 5
            let review =
              'Great experience. Clear requirements and smooth collaboration throughout.'
            try {
              const raw = await generateReply(prompt)
              console.log(
                `[${agentName}] [WS] Review LLM raw: ${raw?.slice(0, 200)}`,
              )
              const match = raw.match(/\{[\s\S]*?\}/)
              if (match) {
                const parsed = JSON.parse(match[0])
                if (
                  Number.isInteger(parsed.rating) &&
                  parsed.rating >= 1 &&
                  parsed.rating <= 5
                )
                  rating = parsed.rating
                if (parsed.review) review = parsed.review
              }
            } catch (err) {
              console.log(
                `[${agentName}] [WS] Review generation failed, using default:`,
                err.message,
              )
            }

            console.log(
              `[${agentName}] [WS] Submitting review for "${job.title}" — ${rating}/5 — receiverId: ${buyerId}`,
            )
            try {
              const reviewData = sdkOk(
                await sdk.job.submitReview(jobId, {
                  receiverId: buyerId,
                  review,
                  rating,
                }),
                'submitReview',
              )
              reviewedJobs.add(jobId)
              saveReviewed()
              console.log(
                `[${agentName}] [WS] Review submitted — id: ${reviewData?._id}`,
              )
            } catch (err) {
              console.error(
                `[${agentName}] [WS] submitReview failed:`,
                err.message,
              )
            }
          } else {
            console.warn(`[${agentName}] [WS] Cannot review — buyer ID unknown`)
          }
        }
      })

      // Buyer: someone applied to one of our jobs — review and accept.
      messaging.onJobApplied(async (event) => {
        const jobId = event?.jobId ?? event?.data?.jobId
        const jobTitle = event?.jobTitle ?? event?.data?.jobTitle ?? jobId
        const applicationId = event?.applicationId ?? event?.data?.applicationId
        const applicantId = event?.applicantId ?? event?.data?.applicantId ?? ''
        const coverLetter = event?.coverLetter ?? event?.data?.coverLetter ?? ''

        console.log(
          `[${agentName}] [WS] APPLICATION RECEIVED — "${jobTitle}" — from ${applicantId}`,
        )
        if (coverLetter)
          console.log(
            `[${agentName}] [WS] Cover letter: "${coverLetter.slice(0, 120)}..."`,
          )

        if (!jobId || !applicationId) {
          console.warn(
            `[${agentName}] [WS] Missing jobId or applicationId — cannot accept`,
          )
          return
        }

        // Generate an acceptance decision via LLM, default to accepting.
        const prompt = [
          `You are a buyer agent reviewing a freelance job application.`,
          `Job: "${jobTitle}"`,
          coverLetter ? `Applicant's cover letter: "${coverLetter}"` : '',
          `Should you accept this application? Reply ONLY with valid JSON: {"accept": true, "reason": "<one sentence>"}`,
        ]
          .filter(Boolean)
          .join('\n')

        let accept = true
        try {
          const raw = await generateReply(prompt)
          const match = raw.match(/\{[\s\S]*?\}/)
          if (match) {
            const parsed = JSON.parse(match[0])
            if (typeof parsed.accept === 'boolean') accept = parsed.accept
          }
        } catch (err) {
          console.log(
            `[${agentName}] [WS] Application decision generation failed, defaulting to accept`,
          )
        }

        if (!accept) {
          console.log(
            `[${agentName}] [WS] Decided NOT to accept application for "${jobTitle}"`,
          )
          return
        }

        try {
          sdkOk(
            await sdk.job.acceptApplication(jobId, applicationId),
            'acceptApplication',
          )
          console.log(
            `[${agentName}] [WS] Accepted application for "${jobTitle}" — invite auto-created for ${applicantId}`,
          )
        } catch (err) {
          console.error(
            `[${agentName}] [WS] acceptApplication failed:`,
            err.message,
          )
        }
      })

      // Seller: our application was accepted — an invite will follow via onJobInvite.
      messaging.onJobApplicationAccepted(async (event) => {
        const jobId = event?.jobId ?? event?.data?.jobId
        const jobTitle = event?.jobTitle ?? event?.data?.jobTitle ?? jobId
        console.log(
          `[${agentName}] [WS] APPLICATION ACCEPTED — "${jobTitle}" — awaiting invite to start work`,
        )
      })

      messaging.onJobCompleted(async (event) => {
        const jobId = event?.jobId ?? event?.data?.jobId
        const jobTitle = event?.jobTitle ?? event?.data?.jobTitle ?? jobId
        const sellerId = event?.senderId ?? event?.data?.senderId ?? ''

        console.log(
          `[${agentName}] [WS] JOB COMPLETED — "${jobTitle}" — seller: ${sellerId} — releasing payment`,
        )
        if (!jobId) return

        // Fetch full job to get escrowChainId and receiver (seller) ID.
        let job = null
        try {
          const jobData = sdkOk(
            await sdk.job.getById(jobId),
            'getById (completion)',
          )
          job = jobData?.job ?? jobData
        } catch (err) {
          console.error(
            `[${agentName}] [WS] Could not fetch job on completion:`,
            err.message,
          )
          return
        }

        // Abort if job isn't in review status (already released or duplicate event).
        if (job?.status !== 'review') {
          console.log(
            `[${agentName}] [WS] Job "${jobTitle}" status is "${job?.status}" — skipping release`,
          )
          return
        }

        const chainId = String(job?.escrowChainId ?? JOB_CHAIN_ID ?? '43113')

        // Release payment: server returns an unsigned markBuyerEscrowReleaseReady() tx.
        let txHash = null
        try {
          const releaseData = sdkOk(
            await sdk.job.releasePayment(jobId),
            'releasePayment',
          )
          const releasePayload = releaseData?.releasePayload
          if (!releasePayload) throw new Error('No releasePayload in response')

          const releaseTx = {
            ...releasePayload,
            chainId: releasePayload.chainId ?? chainId,
          }
          txHash = await signAndBroadcast(releaseTx)
          console.log(
            `[${agentName}] [WS] Release tx broadcast — txHash: ${txHash}`,
          )
          await new Promise((r) => setTimeout(r, 8_000))

          sdkOk(
            await sdk.job.confirmTx(jobId, { step: 'onRelease', txHash }),
            'confirmTx onRelease',
          )
          console.log(
            `[${agentName}] [WS] Payment released — job "${jobTitle}"`,
          )
        } catch (err) {
          console.error(
            `[${agentName}] [WS] releasePayment failed:`,
            err.message,
          )
          return
        }

        // Submit review of seller after releasing payment.
        const receiverId = String(
          job?.receiver?._id ?? job?.receiver ?? sellerId,
        )
        if (receiverId && !reviewedJobs.has(jobId)) {
          const prompt = [
            `You just paid for a freelance job titled: "${job.title}"`,
            job.description ? `Job description: ${job.description}` : '',
            `Write a short professional review of the talent/seller (1-2 sentences) and give a star rating 1-5.`,
            `Reply ONLY with valid JSON: {"rating": <number 1-5>, "review": "<text>"}`,
          ]
            .filter(Boolean)
            .join('\n')

          let rating = 5
          let review =
            'Excellent work. Delivered exactly as described and communicated clearly.'
          try {
            const raw = await generateReply(prompt)
            const match = raw.match(/\{[\s\S]*?\}/)
            if (match) {
              const parsed = JSON.parse(match[0])
              if (
                Number.isInteger(parsed.rating) &&
                parsed.rating >= 1 &&
                parsed.rating <= 5
              )
                rating = parsed.rating
              if (parsed.review) review = parsed.review
            }
          } catch (err) {
            console.log(
              `[${agentName}] [WS] Review generation failed, using default:`,
              err.message,
            )
          }

          console.log(
            `[${agentName}] [WS] Submitting review for seller — ${rating}/5 — receiverId: ${receiverId}`,
          )
          try {
            const reviewData = sdkOk(
              await sdk.job.submitReview(jobId, { receiverId, review, rating }),
              'submitReview (seller)',
            )
            reviewedJobs.add(jobId)
            saveReviewed()
            console.log(
              `[${agentName}] [WS] Seller review submitted — id: ${reviewData?._id}`,
            )
          } catch (err) {
            console.error(
              `[${agentName}] [WS] submitReview (seller) failed:`,
              err.message,
            )
          }
        }
      })

      messaging.onJobReview((event) => {
        const receiverId = String(
          event?.receiverId ?? event?.data?.receiverId ?? '',
        )
        const ownerId = String(event?.senderId ?? event?.data?.senderId ?? '')
        const rating = event?.rating ?? event?.data?.rating
        const review = event?.review ?? event?.data?.review
        const jobId = event?.jobId ?? event?.data?.jobId

        if (receiverId === userId) {
          console.log(
            `[${agentName}] [WS] Review RECEIVED — ${rating}/5 — from ${ownerId} — job: ${jobId}`,
          )
          console.log(`[${agentName}] [WS] Review text: "${review}"`)
        } else if (ownerId === userId) {
          console.log(
            `[${agentName}] [WS] Own review confirmed — ${rating}/5 for ${receiverId} — job: ${jobId}`,
          )
        } else {
          console.log(
            `[${agentName}] [WS] job_review event (role unclear):`,
            JSON.stringify(event)?.slice(0, 200),
          )
        }
      })

      messaging.onBroadcast(async (msg) => {
        if (msg.user === userId) return
        if (!markProcessed(msg._id)) return
        if (!checkTurns(msg.conversation)) {
          console.log(
            `[${agentName}] Turn limit reached for conv ${msg.conversation}`,
          )
          return
        }

        console.log(
          `[${agentName}] Received message from ${msg.user}: ${msg.content?.slice(0, 80)}`,
        )
        messaging.setTyping(msg.conversation, true)

        let reply
        try {
          reply = await generateReply(msg.content ?? '[non-text message]')
        } catch (err) {
          console.error(`[${agentName}] Reply generation failed:`, err.message)
          reply = 'I encountered an error processing your message.'
        }

        messaging.setTyping(msg.conversation, false)
        messaging.sendMessage({
          conversationId: msg.conversation,
          type: 'TEXT',
          message: reply,
        })
        console.log(`[${agentName}] Replied: ${reply?.slice(0, 80)}`)
      })

      // Process invites that arrived while offline
      try {
        const { data: inviteList } = await sdk.job.listAllInvites()
        const pending = (inviteList?.data ?? []).filter(
          (i) => i.direction === 'received' && i.status === 'pending',
        )
        if (pending.length > 0) {
          console.log(
            `[${agentName}] Found ${pending.length} pending invite(s) on connect — processing`,
          )
          for (const invite of pending) {
            if (!markProcessed(`invite:${invite._id}`)) continue
            await handleJobInvite(sdk, messaging, {
              jobId: invite.job._id,
              jobTitle: invite.job.title,
              senderId: invite.sender._id,
              inviteId: invite._id,
            })
          }
        }
      } catch (err) {
        console.error(
          `[${agentName}] Failed to poll pending invites:`,
          err.message,
        )
      }

      // Submit reviews for completed jobs
      try {
        await reviewCompletedJobs(sdk)
      } catch (err) {
        console.error(
          `[${agentName}] Failed to review completed jobs:`,
          err.message,
        )
      }

      // Scan released payments and log on-chain balance per token
      try {
        const paidResult = await sdk.job.list({
          status: 'completed',
          role: 'seller',
          limit: 20,
        })
        const paidJobs = paidResult.data?.data ?? paidResult.data?.jobs ?? []
        const released = paidJobs.filter(
          (j) =>
            (j.escrowStatus === 'released' || j.escrowStatus === 'completed') &&
            (j.seller ?? '').toLowerCase() === agentAddress.toLowerCase(),
        )
        if (released.length > 0) {
          console.log(
            `[${agentName}] Payments received (${released.length} job(s)):`,
          )
          const uniqueTokens = new Map() // chainId-contractAddress → coin (ERC-20 only)
          const uniqueChains = new Set() // all chain IDs seen (for native balance)
          for (const j of released) {
            const coin = j.currency
            const symbol =
              coin?.symbol ?? (typeof coin === 'string' ? coin : 'AVAX')
            const chainId = String(coin?.rpcChainId ?? '43113')
            uniqueChains.add(chainId)
            if (coin?.isToken && coin?.contractAddress) {
              const key = `${chainId}-${coin.contractAddress}`
              if (!uniqueTokens.has(key)) uniqueTokens.set(key, coin)
            }
            console.log(
              `[${agentName}]   "${j.title}" — ${j.amount ?? '?'} ${symbol} | tx: ${j.escrowReleaseTxHash ?? 'n/a'}`,
            )
          }
          // Token balance for each unique ERC-20 used as payment
          for (const coin of uniqueTokens.values()) {
            try {
              const { formatted, symbol } = await readWalletBalance(
                coin,
                agentAddress,
              )
              console.log(
                `[${agentName}] Token balance: ${formatted} ${symbol}`,
              )
            } catch (err) {
              console.error(
                `[${agentName}] Token balance check failed:`,
                err.message,
              )
            }
          }
          // Native coin balance for every chain seen
          for (const chainId of uniqueChains) {
            try {
              const rpcUrl = RPC_URLS[chainId] ?? Object.values(RPC_URLS)[0]
              const provider = new ethers.JsonRpcProvider(rpcUrl)
              const raw = await provider.getBalance(agentAddress)
              const symbol = NATIVE_SYMBOLS[chainId] ?? 'native'
              console.log(
                `[${agentName}] Wallet balance: ${ethers.formatEther(raw)} ${symbol}`,
              )
            } catch (err) {
              console.error(
                `[${agentName}] Native balance check failed:`,
                err.message,
              )
            }
          }
        }
      } catch (err) {
        console.error(`[${agentName}] Failed to scan paid jobs:`, err.message)
      }

      // Read reviews received by this agent
      try {
        const reviewsResult = await sdk.job.getReceivedReviews(userId, {
          limit: 10,
        })
        const reviews = reviewsResult.data?.data ?? []
        if (reviews.length > 0) {
          console.log(`[${agentName}] Reviews received (${reviews.length}):`)
          for (const r of reviews) {
            const from = r.owner?.firstName ?? r.owner?._id ?? 'unknown'
            console.log(
              `[${agentName}]   ${r.rating}/5 from ${from}: "${r.review}"`,
            )
          }
        }
      } catch (err) {
        console.error(
          `[${agentName}] Failed to fetch received reviews:`,
          err.message,
        )
      }

      // Resume ongoing jobs with pending deliverables
      try {
        const jobListResult = await sdk.job.list({
          status: 'ongoing',
          role: 'seller',
          limit: 20,
        })
        const ongoingJobs =
          jobListResult.data?.data ?? jobListResult.data?.jobs ?? []
        const resumable = ongoingJobs.filter((j) => {
          const isSeller =
            !j.seller ||
            (j.seller ?? '').toLowerCase() === agentAddress.toLowerCase()
          const deliverables = j.deliverables ?? []
          return (
            isSeller &&
            deliverables.length > 0 &&
            deliverables.some((d) => d.status !== 'completed')
          )
        })
        if (resumable.length > 0) {
          console.log(
            `[${agentName}] Found ${resumable.length} ongoing job(s) with pending deliverables — resuming`,
          )
          for (const j of resumable) {
            if (!markProcessed(`job:${j._id}`)) continue
            executeJob(sdk, messaging, String(j._id)).catch((err) =>
              console.error(
                `[${agentName}] executeJob (resume) failed:`,
                err.message,
              ),
            )
          }
        }
      } catch (err) {
        console.error(
          `[${agentName}] Failed to poll ongoing jobs:`,
          err.message,
        )
      }

      // Buyer mode: create a job and invite the target agent (first connect only).
      if (INVITE_AGENT_ADDRESS && !buyerJobCreated) {
        buyerJobCreated = true
        createJobAndInvite(sdk, INVITE_AGENT_ADDRESS).catch((err) =>
          console.error(
            `[${agentName}] createJobAndInvite failed:`,
            err.message,
          ),
        )
      }

      // Seller mode: scan for public open jobs and apply immediately, then on a timer.
      scanAndApply(sdk, userId).catch((err) =>
        console.error(
          `[${agentName}] Initial scanAndApply failed:`,
          err.message,
        ),
      )
      if (scanTimer) clearInterval(scanTimer)
      scanTimer = setInterval(() => {
        scanAndApply(sdk, userId).catch((err) =>
          console.error(`[${agentName}] scanAndApply failed:`, err.message),
        )
      }, SCAN_INTERVAL_MS)

      // Hold open until the socket disconnects
      await new Promise((resolve) => {
        const heartbeat = setInterval(() => {
          if (!messaging.connected) {
            clearInterval(heartbeat)
            console.log(`[${agentName}] Disconnected — reconnecting...`)
            resolve()
          }
        }, HEARTBEAT_MS)
      })
      // Explicitly close the old socket so the server removes it from the
      // user room before the reconnect creates a new one. Without this, both
      // sockets linger in the room and every broadcasted event fires twice.
      clearInterval(scanTimer)
      try {
        messaging.disconnect()
      } catch {}
    } catch (err) {
      console.error(
        `[${agentName}] Connection error:`,
        err.message,
        '— retrying in 10s',
      )
      clearInterval(scanTimer)
      try {
        messaging?.disconnect()
      } catch {}
      await new Promise((r) => setTimeout(r, 10_000))
    }
  }
}

// ── Entry point ────────────────────────────────────────────────────────────
// One-shot CLI subcommand → runCLI + exit.
// No subcommand, 'start', or flags-only → daemon mode.

if (_isCliMode) {
  runCLI()
    .then(() => process.exit(0))
    .catch((err) => {
      process.stderr.write(`Error: ${err.message}\n`)
      process.exit(1)
    })
} else {
  run()
}
