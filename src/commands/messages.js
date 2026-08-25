import { parseCommand, resolveConfig } from '../config.js'
import { cliInit, sdkOk } from '../client.js'
import { withMessaging } from '../messaging.js'
import { out, print, note, fail, cliTable } from '../output.js'

export const usage = `psilocli messages list
psilocli messages history <conversationId> [--limit <n>]
psilocli messages send (--to <userId> | --conversation <id>) [--attachment <fileId>...] [<text>]
psilocli messages create-group <name> <userId...>
psilocli messages seen <conversationId>
psilocli messages watch [--conversation <id>]`

function recipientNames(recipients = []) {
  return recipients
    .map((r) => `${r.firstName ?? ''} ${r.lastName ?? ''}`.trim() || r._id)
    .join(', ')
}

async function listConversations(argv) {
  const { values } = parseCommand(argv)
  const config = resolveConfig(values)
  const { jwt } = await cliInit(config)
  const conversations = await withMessaging(config, jwt, async (messaging) => {
    return await messaging.loadConversations()
  })
  if (config.json) {
    out(conversations)
  } else if (conversations.length === 0) {
    print('No conversations found.')
  } else {
    cliTable(
      conversations.map((c) => {
        const last = c.messages?.[c.messages.length - 1]
        return [
          String(c._id).slice(-8),
          c.type ?? '',
          (c.name ?? recipientNames(c.recipients)).slice(0, 30),
          (last?.content ?? '').slice(0, 40),
          c.updatedAt ?? '',
        ]
      }),
      ['ID', 'Type', 'With', 'Last message', 'Updated'],
    )
  }
}

async function history(argv) {
  const { values, positionals } = parseCommand(
    argv,
    { limit: { type: 'string' } },
    { positionals: true },
  )
  const conversationId = positionals[0]
  if (!conversationId)
    fail('Usage: psilocli messages history <conversationId> [--limit <n>]', 2)
  const limit = parseInt(values.limit ?? '50', 10)

  const config = resolveConfig(values)
  const { jwt } = await cliInit(config)
  const conversation = await withMessaging(config, jwt, async (messaging) => {
    return await messaging.fetchConversation(conversationId)
  })
  const all = conversation?.chats?.messages ?? []
  const messages = all.slice(-limit)
  if (config.json) {
    out(messages)
  } else if (messages.length === 0) {
    print('No messages in this conversation.')
  } else {
    for (const m of messages) {
      print(`[${m.createdAt ?? ''}] ${m.user}: ${m.content ?? ''}`)
    }
    if (all.length > messages.length)
      note(`Showing last ${messages.length} of ${all.length} messages`)
  }
}

async function send(argv) {
  const { values, positionals } = parseCommand(
    argv,
    {
      to:         { type: 'string' },
      conversation: { type: 'string' },
      attachment: { type: 'string', multiple: true },
    },
    { positionals: true },
  )
  const text        = positionals.join(' ')
  const attachments = values.attachment ?? []

  if ((!values.to && !values.conversation) || (values.to && values.conversation))
    fail(
      'Usage: psilocli messages send (--to <userId> | --conversation <id>) [--attachment <fileId>...] [<text>]',
      2,
    )
  if (!text && attachments.length === 0)
    fail('Message text or at least one --attachment is required', 2)

  const hasText        = Boolean(text)
  const hasAttachments = attachments.length > 0
  const msgType = hasText && hasAttachments ? 'TEXT_MEDIA'
                : hasAttachments            ? 'MEDIA'
                :                            'TEXT'

  const config = resolveConfig(values)
  const { sdk, jwt } = await cliInit(config)

  // Pre-flight: verify every attachment ID exists before opening the socket
  for (const attachmentId of attachments) {
    sdkOk(
      await sdk.upload.getUpload(attachmentId),
      `upload.getUpload(${attachmentId})`,
    )
  }

  const conversationId = await withMessaging(config, jwt, async (messaging) => {
    let convId = values.conversation
    if (!convId) {
      const conv = await messaging.createDirectConversation(values.to)
      convId = conv._id
      if (!convId) throw new Error('Could not open a conversation')
    }
    await messaging.sendMessage({
      conversationId: convId,
      type: msgType,
      ...(hasText        ? { message: text }   : {}),
      ...(hasAttachments ? { attachments }      : {}),
    })
    return convId
  })
  if (config.json) out({ ok: true, conversationId })
  else print(`Message sent (conversation: ${conversationId})`)
}

async function createGroup(argv) {
  const { values, positionals } = parseCommand(argv, {}, { positionals: true })
  const [name, ...userIds] = positionals
  if (!name || userIds.length === 0)
    fail('Usage: psilocli messages create-group <name> <userId...>', 2)

  const config = resolveConfig(values)
  const { jwt } = await cliInit(config)
  const conversation = await withMessaging(config, jwt, async (messaging) => {
    return await messaging.createGroupConversation(userIds, name)
  })
  if (config.json) out({ ok: true, conversationId: conversation._id })
  else print(`Group "${name}" created (conversation: ${conversation._id})`)
}

async function seen(argv) {
  const { values, positionals } = parseCommand(argv, {}, { positionals: true })
  const conversationId = positionals[0]
  if (!conversationId)
    fail('Usage: psilocli messages seen <conversationId>', 2)

  const config = resolveConfig(values)
  const { jwt } = await cliInit(config)
  await withMessaging(config, jwt, (messaging) => {
    messaging.markSeen(conversationId)
  })
  if (config.json) out({ ok: true, conversationId })
  else print(`Conversation ${conversationId} marked seen`)
}

// The one messages command that stays connected: prints incoming broadcasts
// until Ctrl-C. Foreground tail, not a daemon — no reconnect logic.
async function watch(argv) {
  const { values } = parseCommand(argv, { conversation: { type: 'string' } })
  const config = resolveConfig(values)
  const { jwt, userId } = await cliInit(config)

  await withMessaging(config, jwt, (messaging) => {
    note(
      values.conversation
        ? `Watching conversation ${values.conversation} — Ctrl-C to stop`
        : 'Watching all conversations — Ctrl-C to stop',
    )
    messaging.onBroadcast((m) => {
      if (values.conversation && m.conversation !== values.conversation) return
      if (config.json) {
        process.stdout.write(JSON.stringify(m) + '\n')
      } else {
        const who = m.user === userId ? 'me' : m.user
        print(`[${m.createdAt ?? new Date().toISOString()}] ${who}: ${m.content ?? ''}`)
      }
    })
    return new Promise((resolve) => {
      process.on('SIGINT', () => resolve())
      process.on('SIGTERM', () => resolve())
    })
  })
}

const SUBCOMMANDS = {
  list: listConversations,
  history,
  send,
  'create-group': createGroup,
  seen,
  watch,
}

export async function run(argv) {
  const sub = argv[0]
  const handler = SUBCOMMANDS[sub]
  if (!handler) fail(`Usage:\n${usage}`, 2)
  await handler(argv.slice(1))
}
