import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseCommand, resolveConfig } from '../config.js'
import { sdkOk } from '../client.js'
import { out, print, note, fail, cliTable } from '../output.js'
import { VERDICTS, castVote, cliInitSigned, readText, voteStore } from '../issues.js'

export const usage = `psilocli jury invites
psilocli jury accept <issueId>
psilocli jury decline <issueId>
psilocli jury evidence <issueId> [--out <dir>]
psilocli jury vote <issueId> --verdict plaintiff|defense (--rationale <t> | --rationale-file <f>)
psilocli jury vote <issueId> --resume`

function issueArg(positionals) {
  const issueId = positionals[0]
  if (!issueId) fail(`Usage:\n${usage}`, 2)
  return issueId
}

// Open invites only: the API lists every issue you touch, this narrows it to the ones waiting on you.
async function invites(argv) {
  const { values } = parseCommand(argv)
  const config = resolveConfig(values)
  const { sdk, userId } = await cliInitSigned(config)
  const res = sdkOk(await sdk.issue.list({ limit: 100 }), 'issue.list')
  const rows = (res.data ?? [])
    .map((i) => ({ issue: i, invite: (i.invites ?? []).find((v) => String(v.userId) === userId) }))
    .filter(({ issue, invite }) => invite?.status === 'invited' && issue.status === 'in_review')
  if (config.json) return out(rows.map(({ issue, invite }) => ({ issueId: issue._id, jobId: issue.job, invitedAt: invite.invitedAt, sealedAt: issue.sealedAt })))
  if (rows.length === 0) return print('No open panel invitations.')
  cliTable(
    rows.map(({ issue, invite }) => [issue._id, String(issue.job), new Date(invite.invitedAt).toISOString().replace('T', ' ').slice(0, 16)]),
    ['Issue', 'Job', 'Invited (UTC)'],
  )
  note('Accept with `psilocli jury accept <issueId>`, read the case with `psilocli jury evidence <issueId>`.')
}

async function accept(argv) {
  const { values, positionals } = parseCommand(argv, {}, { positionals: true })
  const issueId = issueArg(positionals)
  const config = resolveConfig(values)
  const { sdk, userId } = await cliInitSigned(config)
  const { issue } = sdkOk(await sdk.issue.juryAccept(issueId), 'issue.juryAccept')
  const seat = (issue.panel ?? []).find((s) => String(s.jurorId) === userId && !s.replaced)
  if (config.json) return out({ ok: true, issueId, seat: seat?.seat ?? null, verdictDeadline: seat?.verdictDeadline ?? null })
  print(`Seated on issue ${issueId}${seat ? ` (seat ${seat.seat})` : ''}.`)
  if (seat) print(`Commit and reveal your vote before ${new Date(seat.verdictDeadline).toISOString()} or the seat is replaced unpaid.`)
}

async function decline(argv) {
  const { values, positionals } = parseCommand(argv, {}, { positionals: true })
  const issueId = issueArg(positionals)
  const config = resolveConfig(values)
  const { sdk } = await cliInitSigned(config)
  sdkOk(await sdk.issue.juryDecline(issueId), 'issue.juryDecline')
  if (config.json) return out({ ok: true, issueId, declined: true })
  print(`Declined the invitation to issue ${issueId}.`)
}

function renderEvidence(ev) {
  const lines = [
    `# Issue ${ev.issueId}`,
    '',
    `The plaintiff is the job's ${ev.plaintiffRole}.`,
    '',
    `## Job: ${ev.job.title}`,
    '',
    `- Value: ${ev.job.amount} (asset ${ev.job.asset || 'native'})`,
    `- Status before the dispute: ${ev.job.statusBeforeDispute}`,
    '',
    ev.job.description,
    '',
    '### Deliverables',
    '',
    ...ev.job.deliverables.map(
      (d, i) => `${i + 1}. ${d.description} — ${d.status}${d.comment ? `\n\n   ${d.comment.replace(/\n/g, '\n   ')}` : ''}`,
    ),
    '',
    '### Completion note',
    '',
    ev.job.completionNote || '(none)',
    '',
    `## Complaint: ${ev.plaintiff.title}`,
    '',
    ev.plaintiff.content,
    '',
    `## Defence: ${ev.defense.title}`,
    '',
    ev.defense.content,
    '',
    '## Chat between the parties',
    '',
    ...(ev.chatHistory.length
      ? ev.chatHistory.map((m) => `- [${new Date(m.at).toISOString()}] **${m.role}:** ${m.content}`)
      : ['(no messages)']),
    '',
  ]
  return lines.join('\n')
}

async function evidence(argv) {
  const { values, positionals } = parseCommand(argv, { out: { type: 'string' } }, { positionals: true })
  const issueId = issueArg(positionals)
  const config = resolveConfig(values)
  const { sdk } = await cliInitSigned(config)
  const ev = sdkOk(await sdk.issue.evidence(issueId), 'issue.evidence')
  if (config.json) return out(ev)
  const text = renderEvidence(ev)
  if (values.out) {
    mkdirSync(values.out, { recursive: true })
    const file = join(values.out, `issue-${issueId}.md`)
    writeFileSync(file, text)
    return print(`Evidence written to ${file}`)
  }
  print(text)
}

async function vote(argv) {
  const { values, positionals } = parseCommand(
    argv,
    {
      verdict: { type: 'string' },
      rationale: { type: 'string' },
      'rationale-file': { type: 'string' },
      resume: { type: 'boolean' },
    },
    { positionals: true },
  )
  const issueId = issueArg(positionals)
  let rationale = ''
  if (!values.resume) {
    if (!VERDICTS.includes(values.verdict)) fail('--verdict must be plaintiff or defense', 2)
    rationale = readText(values, 'rationale', 'rationale-file')
    if (!rationale) fail('--rationale or --rationale-file is required: the panel records why, not just what', 2)
  }
  const config = resolveConfig(values)
  const { sdk, userId } = await cliInitSigned(config)

  if (!values.resume) {
    const issue = sdkOk(await sdk.issue.get(issueId), 'issue.get')
    const seat = (issue.panel ?? []).find((s) => String(s.jurorId) === userId && !s.replaced)
    if (!seat) fail(`You hold no seat on issue ${issueId}. Accept the invitation first: psilocli jury accept ${issueId}`)
    if (seat.revealed) fail(`Your vote on issue ${issueId} is already revealed.`)
    if (Date.now() > new Date(seat.verdictDeadline).getTime())
      fail(`The verdict limit for your seat passed at ${new Date(seat.verdictDeadline).toISOString()}.`)
    note('Your rationale is stored with the issue and shown to the parties after the verdict; only its hash is published on chain.')
  }

  const result = await castVote(
    sdk,
    issueId,
    { verdict: values.verdict, rationale, resume: Boolean(values.resume) },
    voteStore(),
    note,
  )
  if (config.json) return out({ ok: true, issueId, ...result })
  if (result.alreadyRevealed) return print(`Your vote on issue ${issueId} was already revealed.`)
  print(`Vote revealed on issue ${issueId}${result.onTime ? ' (on time)' : ' (late: no reward)'}. Issue status: ${result.issueStatus}.`)
}

const SUBCOMMANDS = { invites, accept, decline, evidence, vote }

export async function run(argv) {
  const handler = SUBCOMMANDS[argv[0]]
  if (!handler) fail(`Usage:\n${usage}`, 2)
  await handler(argv.slice(1))
}
