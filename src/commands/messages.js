import { parseArgs } from 'node:util'
import { MessagingService } from '@pakt/psilo'
import { withMessaging } from '../messaging.js'
import { out, fail, cliTable } from '../output.js'

function fmtTime(iso) {
  try {
    const d = new Date(iso)
    return d.toTimeString().slice(0, 8)
  } catch {
    return '??:??:??'
  }
}

// ── messages list ─────────────────────────────────────────────────────────────

async function subList(config, auth) {
  await withMessaging({ url: config.url, jwt: auth.jwt }, async (messaging) => {
    const convos = await messaging.loadConversations()
    const list = convos?.data ?? convos ?? []

    if (config.json) {
      out(list)
      return
    }
    if (list.length === 0) {
      process.stdout.write('No conversations found.\n')
      return
    }
    cliTable(
      list.map((c) => {
        const recipients = (c.recipients ?? [])
          .map((r) => `${r.firstName ?? ''} ${r.lastName ?? ''}`.trim() || r._id)
          .join(', ')
        const preview = (c.lastMessage?.content ?? c.lastMessage?.message ?? '').slice(0, 40)
        return [
          String(c._id).slice(-8),
          c.type ?? '',
          recipients.slice(0, 30),
          preview,
          c.updatedAt ? new Date(c.updatedAt).toISOString().slice(0, 16) : '',
        ]
      }),
      ['ID', 'Type', 'Recipients', 'Last message', 'Updated'],
    )
  })
}

// ── messages history ──────────────────────────────────────────────────────────

async function subHistory(config, auth, args) {
  const { values: flags, positionals } = parseArgs({
    args,
    options: { limit: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  })
  const conversationId = positionals[0]
  if (!conversationId)
    fail('Usage: psilocli messages history <conversationId> [--limit n]', 2)

  await withMessaging({ url: config.url, jwt: auth.jwt }, async (messaging) => {
    const fetched = await messaging.fetchConversation(conversationId)
    let messages = fetched?.chats?.messages ?? fetched?.messages ?? []

    const limit = flags.limit ? parseInt(flags.limit, 10) : messages.length
    // Reverse to oldest-first, then apply limit
    messages = messages.slice().reverse().slice(0, limit)

    if (config.json) {
      out(messages)
      return
    }
    if (messages.length === 0) {
      process.stdout.write('No messages.\n')
      return
    }
    for (const m of messages) {
      const time = fmtTime(m.createdAt)
      const sender = m.user ?? m.sender ?? m.senderId ?? 'unknown'
      const content = m.content ?? m.message ?? ''
      process.stdout.write(`[${time}] ${sender}: ${content}\n`)
    }
  })
}

// ── messages send ─────────────────────────────────────────────────────────────

async function subSend(config, auth, args) {
  const { values: flags, positionals } = parseArgs({
    args,
    options: {
      to:           { type: 'string' },
      conversation: { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  })

  const text = positionals.join(' ')
  if (!text) fail('Usage: psilocli messages send (--to <userId> | --conversation <id>) <text>', 2)
  if (!flags.to && !flags.conversation)
    fail('Either --to <userId> or --conversation <id> is required', 2)

  await withMessaging({ url: config.url, jwt: auth.jwt }, async (messaging) => {
    let conversationId = flags.conversation

    if (!conversationId) {
      const convo = await Promise.race([
        messaging.createDirectConversation(flags.to),
        new Promise((_, r) =>
          setTimeout(() => r(new Error('createDirectConversation timed out')), 10_000),
        ),
      ])
      conversationId = convo._id
    }

    messaging.sendMessage({ conversationId, type: 'TEXT', message: text })

    // Wait for the onBroadcast echo of our own message (matched by conversationId),
    // with a 2s flush-delay fallback.
    await Promise.race([
      new Promise((resolve) => {
        messaging.onBroadcast((msg) => {
          if (String(msg.conversation ?? msg.conversationId) === String(conversationId)) {
            resolve()
          }
        })
      }),
      new Promise((r) => setTimeout(r, 2_000)),
    ])

    if (config.json) out({ ok: true, conversationId })
    else process.stdout.write(`Message sent (conversation: ${conversationId})\n`)
  })
}

// ── messages create-group ─────────────────────────────────────────────────────

async function subCreateGroup(config, auth, args) {
  const { positionals } = parseArgs({
    args,
    options: {},
    allowPositionals: true,
    strict: true,
  })
  const [name, ...userIds] = positionals
  if (!name || userIds.length === 0)
    fail('Usage: psilocli messages create-group <name> <userId...>', 2)

  await withMessaging({ url: config.url, jwt: auth.jwt }, async (messaging) => {
    const convo = await messaging.createGroupConversation(name, userIds)
    const conversationId = convo?._id ?? convo

    if (config.json) out({ ok: true, conversationId })
    else process.stdout.write(`Group created — conversationId: ${conversationId}\n`)
  })
}

// ── messages seen ─────────────────────────────────────────────────────────────

async function subSeen(config, auth, args) {
  const { positionals } = parseArgs({
    args,
    options: {},
    allowPositionals: true,
    strict: true,
  })
  const conversationId = positionals[0]
  if (!conversationId) fail('Usage: psilocli messages seen <conversationId>', 2)

  await withMessaging({ url: config.url, jwt: auth.jwt }, async (messaging) => {
    await messaging.markSeen(conversationId)
    if (config.json) out({ ok: true, conversationId })
    else process.stdout.write(`Marked seen: ${conversationId}\n`)
  })
}

// ── messages watch ────────────────────────────────────────────────────────────

async function subWatch(config, auth, args) {
  const { values: flags } = parseArgs({
    args,
    options: { conversation: { type: 'string' } },
    strict: true,
  })

  const filterConvo = flags.conversation ?? null

  // watch stays open — does not use withMessaging()
  const messaging = new MessagingService(config.url, auth.jwt)
  await Promise.race([
    messaging.connect(),
    new Promise((_, r) =>
      setTimeout(() => r(new Error('Messaging connect timed out after 10s')), 10_000),
    ),
  ])

  process.stderr.write(
    filterConvo
      ? `Watching conversation ${filterConvo} — Ctrl-C to exit\n`
      : 'Watching all messages — Ctrl-C to exit\n',
  )

  messaging.onBroadcast((msg) => {
    if (filterConvo && String(msg.conversation ?? msg.conversationId) !== String(filterConvo)) {
      return
    }
    const time = fmtTime(msg.createdAt ?? new Date().toISOString())
    const sender = msg.user ?? msg.sender ?? 'unknown'
    const content = msg.content ?? msg.message ?? ''

    if (config.json) {
      process.stdout.write(JSON.stringify(msg) + '\n')
    } else {
      process.stdout.write(`[${time}] ${sender}: ${content}\n`)
    }
  })

  process.on('SIGINT', () => {
    try { messaging.disconnect() } catch {}
    process.exit(0)
  })

  // Keep process alive — the socket holds the event loop open.
}

// ── Router ────────────────────────────────────────────────────────────────────

export async function cmdMessages(config, auth, args) {
  const sub = args[0]
  const rest = args.slice(1)

  switch (sub) {
    case 'list':         return subList(config, auth)
    case 'history':      return subHistory(config, auth, rest)
    case 'send':         return subSend(config, auth, rest)
    case 'create-group': return subCreateGroup(config, auth, rest)
    case 'seen':         return subSeen(config, auth, rest)
    case 'watch':        return subWatch(config, auth, rest)
    default:
      fail(
        'Usage: psilocli messages list | history | send | create-group | seen | watch',
        2,
      )
  }
}
