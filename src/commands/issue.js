import { parseCommand, resolveConfig } from '../config.js'
import { sdkOk } from '../client.js'
import { signAndBroadcast } from '../chains.js'
import { out, print, note, fail, cliTable } from '../output.js'
import {
  cliInitSigned,
  escrowDisputed,
  fmtUnits,
  partyRole,
  raiseDisputePayload,
  readText,
  tokenMeta,
} from '../issues.js'

export const usage = `psilocli issue open <jobId> --title <t> (--content <t> | --content-file <f>) [--attachment <uploadId>...] --yes [--rpc <url>]
psilocli issue open --resume <issueId> [--rpc <url>]
psilocli issue withdraw <issueId>
psilocli issue defend <issueId> --title <t> (--content <t> | --content-file <f>) [--attachment <uploadId>...]
psilocli issue show <issueId>
psilocli issue list [--role plaintiff|defender|juror|invitee] [--status <s>]`

const STATEMENT_OPTIONS = {
  title: { type: 'string' },
  content: { type: 'string' },
  'content-file': { type: 'string' },
  attachment: { type: 'string', multiple: true },
}

function statement(values) {
  if (!values.title) fail('--title is required', 2)
  const content = readText(values, 'content', 'content-file')
  if (!content) fail('--content or --content-file is required', 2)
  return {
    title: values.title,
    content,
    ...(values.attachment?.length ? { attachments: values.attachment } : {}),
  }
}

// ── open ────────────────────────────────────────────────────────────────────

async function open(argv) {
  const { values, positionals } = parseCommand(
    argv,
    { ...STATEMENT_OPTIONS, yes: { type: 'boolean' }, resume: { type: 'string' }, rpc: { type: 'string' } },
    { positionals: true },
  )
  const config = resolveConfig(values)
  if (values.resume) return resumeOpen(config, values.resume, values.rpc)

  const jobId = positionals[0]
  if (!jobId) fail(`Usage:\n${usage}`, 2)
  const dto = { jobId, ...statement(values) }

  const { sdk, userId } = await cliInitSigned(config)
  const job = sdkOk(await sdk.job.getById(jobId), 'job.getById')
  const role = partyRole(job, userId)
  if (!role) fail(`You are not the buyer or the accepted seller of job ${jobId}.`)
  if (!['ongoing', 'review'].includes(job.status))
    fail(`Job ${jobId} is ${job.status}; an issue can only be opened on an ongoing or review job.`)

  // Opening freezes the escrow until a panel decides, and the winner pays 5% of the job value.
  if (!values.yes) {
    fail(
      `Opening an issue on job ${jobId} (${job.amount} job value) freezes its escrow: no release, ` +
        'cancel or completion until a sealed panel decides. The winner takes the escrow minus a 5% ' +
        'dispute fee; the loser gets nothing. Re-run with --yes to open it.',
      2,
    )
  }

  const opened = sdkOk(await sdk.issue.open(dto), 'issue.open')
  const issueId = opened.issue._id
  note(`Issue ${issueId} created (${opened.issue.status}) — you are the plaintiff (${role})`)

  let txHash = opened.issue.raiseDisputeTxHash || null
  let issue = opened.issue
  if (opened.raiseDisputePayload) {
    note('Signing raiseDispute() on the escrow...')
    txHash = await signAndBroadcast(sdk, config.key, opened.raiseDisputePayload, values.rpc ?? null)
    note(`raiseDispute confirmed — txHash: ${txHash}; confirming with API...`)
    issue = await confirm(sdk, issueId, txHash)
  }
  report(config, issue, txHash)
}

// A crashed open: read the escrow, sign raiseDispute() only if it has not landed, then confirm.
async function resumeOpen(config, issueId, rpc) {
  const { sdk } = await cliInitSigned(config)
  let issue = sdkOk(await sdk.issue.get(issueId), 'issue.get')
  if (issue.status !== 'awaiting_onchain') {
    note(`Issue ${issueId} is already ${issue.status}; nothing to resume.`)
    return report(config, issue, issue.raiseDisputeTxHash || null)
  }
  let txHash = null
  if (await escrowDisputed(sdk, issue.escrowAddress, issue.escrowChainId)) {
    note('The escrow already reports the dispute; confirming with API...')
  } else {
    note('raiseDispute() has not landed; signing it now...')
    txHash = await signAndBroadcast(sdk, config.key, raiseDisputePayload(issue.escrowAddress, issue.escrowChainId), rpc ?? null)
    note(`raiseDispute confirmed — txHash: ${txHash}; confirming with API...`)
  }
  issue = await confirm(sdk, issueId, txHash)
  report(config, issue, txHash)
}

async function confirm(sdk, issueId, txHash) {
  const res = await sdk.issue.confirmOpen(issueId, txHash ?? undefined, {
    onRetry: ({ attempt, attempts, message }) =>
      note(`  confirm-open attempt ${attempt}/${attempts} failed (${message}); retrying...`),
  })
  return sdkOk(res, 'issue.confirmOpen').issue
}

function report(config, issue, txHash) {
  if (config.json) return out({ ok: true, issueId: issue._id, status: issue.status, raiseDisputeTxHash: txHash })
  print(`Issue:   ${issue._id}`)
  print(`Status:  ${issue.status}`)
  if (txHash) print(`Raise tx: ${txHash}`)
  note('The escrow is frozen. The other party now has one defence; then a sealed panel decides.')
}

// ── withdraw / defend ───────────────────────────────────────────────────────

async function withdraw(argv) {
  const { values, positionals } = parseCommand(argv, {}, { positionals: true })
  const issueId = positionals[0]
  if (!issueId) fail(`Usage:\n${usage}`, 2)
  const config = resolveConfig(values)
  const { sdk } = await cliInitSigned(config)
  const { issue } = sdkOk(await sdk.issue.withdraw(issueId), 'issue.withdraw')
  if (config.json) return out({ ok: true, issueId, status: issue.status })
  print(`Issue ${issueId} ${issue.status}. Nobody is locked by it any more.`)
}

async function defend(argv) {
  const { values, positionals } = parseCommand(argv, STATEMENT_OPTIONS, { positionals: true })
  const issueId = positionals[0]
  if (!issueId) fail(`Usage:\n${usage}`, 2)
  const dto = statement(values)
  const config = resolveConfig(values)
  const { sdk, userId } = await cliInitSigned(config)

  const current = sdkOk(await sdk.issue.get(issueId), 'issue.get')
  if (String(current.defender) !== userId) fail(`You are not the defender on issue ${issueId}.`)
  if (current.defenseAt || current.status !== 'submitted')
    fail(`Issue ${issueId} is ${current.status}; the defence can be submitted once, while it is submitted.`)

  const { issue } = sdkOk(await sdk.issue.defend(issueId, dto), 'issue.defend')
  if (config.json) return out({ ok: true, issueId, status: issue.status })
  print(`Defence recorded on issue ${issueId}. Status: ${issue.status} — the panel is sealed and invited.`)
}

// ── show / list ─────────────────────────────────────────────────────────────

async function show(argv) {
  const { values, positionals } = parseCommand(argv, {}, { positionals: true })
  const issueId = positionals[0]
  if (!issueId) fail(`Usage:\n${usage}`, 2)
  const config = resolveConfig(values)
  const { sdk } = await cliInitSigned(config)

  const issue = sdkOk(await sdk.issue.get(issueId), 'issue.get')
  const previewRes = await sdk.issue.settlementPreview(issueId)
  const preview = previewRes?.status === 'error' ? null : previewRes.data
  if (config.json) return out({ ...issue, settlementPreview: preview })

  const job = sdkOk(await sdk.job.getById(String(issue.job)), 'job.getById')
  const meta = await tokenMeta(sdk, job)
  print(`Issue:      ${issue._id}`)
  print(`Job:        ${issue.job} (${job.title ?? ''})`)
  print(`Status:     ${issue.status}${issue.poolExhausted ? ' (paused: no eligible juror left)' : ''}`)
  print(`Plaintiff:  ${issue.plaintiffRole} — "${issue.issue?.title ?? ''}"`)
  print(`Defence:    ${issue.defenseAt ? `"${issue.defense?.title ?? ''}"` : 'not yet submitted'}`)
  if (issue.raiseDisputeTxHash) print(`Raise tx:   ${issue.raiseDisputeTxHash}`)
  if (issue.panel?.length) {
    print(`Panel:      round ${issue.round}`)
    cliTable(
      issue.panel.map((s) => [
        s.isOverseer ? 'Overseer' : `seat ${s.seat}`,
        s.replaced ? 'replaced' : s.revealed ? 'revealed' : s.committed ? 'committed' : 'waiting',
        new Date(s.verdictDeadline).toISOString().replace('T', ' ').slice(0, 16),
        s.verdict ?? '',
      ]),
      ['Seat', 'State', 'Deadline (UTC)', 'Verdict'],
    )
  }
  const own = issue.invites?.[0]
  if (own) print(`Your invite: ${own.status}`)
  if (issue.verdict) print(`Verdict:    ${issue.verdict} (${issue.outcome}, decided by ${issue.decidedBy || 'panel'})`)
  print(`Settlement: ${issue.settlement?.status ?? 'pending'}${issue.settlement?.txHash ? ` — tx ${issue.settlement.txHash}` : ''}`)
  const p = preview?.preview
  if (p) {
    print(`If settled: winner receives ${fmtUnits(p.winnerPayout, meta)} (job ${fmtUnits(p.amount, meta)} minus ${fmtUnits(p.disputeFee, meta)} dispute fee);`)
    print(`            each on-time juror ${fmtUnits(p.jurorEach, meta)} as $PAKT; liquidity ${fmtUnits(p.liquidity, meta)}`)
  }
}

const ROLE_OF = {
  plaintiff: (i, uid) => String(i.plaintiff) === uid,
  defender: (i, uid) => String(i.defender) === uid,
  juror: (i, uid) => (i.panel ?? []).some((s) => String(s.jurorId) === uid),
  invitee: (i, uid) => (i.invites ?? []).some((v) => String(v.userId) === uid),
}

function roleIn(issue, uid) {
  return Object.keys(ROLE_OF).find((r) => ROLE_OF[r](issue, uid)) ?? ''
}

async function list(argv) {
  const { values } = parseCommand(argv, {
    role: { type: 'string' },
    status: { type: 'string' },
    limit: { type: 'string' },
    page: { type: 'string' },
  })
  if (values.role && !ROLE_OF[values.role]) fail('--role must be plaintiff, defender, juror or invitee', 2)
  const config = resolveConfig(values)
  const { sdk, userId } = await cliInitSigned(config)
  const res = sdkOk(
    await sdk.issue.list({ page: Number(values.page) || 1, limit: Number(values.limit) || 50 }),
    'issue.list',
  )
  const statuses = values.status ? values.status.split(',').map((s) => s.trim()) : null
  const rows = (res.data ?? []).filter(
    (i) => (!values.role || ROLE_OF[values.role](i, userId)) && (!statuses || statuses.includes(i.status)),
  )
  if (config.json) return out(rows)
  if (rows.length === 0) {
    const filters = [values.role && `role ${values.role}`, values.status && `status ${values.status}`].filter(Boolean)
    return print(`No issues found${filters.length ? ` (${filters.join(', ')})` : ''}.`)
  }
  cliTable(
    rows.map((i) => [i._id, String(i.job), i.status, roleIn(i, userId), i.verdict || '', i.issue?.title ?? '']),
    ['Issue', 'Job', 'Status', 'You are', 'Verdict', 'Title'],
  )
}

const SUBCOMMANDS = { open, withdraw, defend, show, list }

export async function run(argv) {
  const handler = SUBCOMMANDS[argv[0]]
  if (!handler) fail(`Usage:\n${usage}`, 2)
  await handler(argv.slice(1))
}
