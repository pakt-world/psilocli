import { MessagingService } from '@pakt/psilo'

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

export function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label} timed out after ${ms / 1000}s`)),
        ms,
      ),
    ),
  ])
}

// Opens a short-lived socket for one-shot commands: connect → fn → disconnect.
export async function withMessaging(config, jwt, fn) {
  const messaging = new MessagingService(config.url, jwt)
  await messaging.connect()
  try {
    return await fn(messaging)
  } finally {
    try {
      messaging.disconnect()
    } catch {}
  }
}

// Workaround until @pakt/psilo speaks acks: paktsuite replies to chat events
// via socket.io acknowledgements, but the SDK's request/response methods
// (loadConversations, createDirectConversation, fetchConversation, ...) emit
// without an ack and wait for a same-named event the server never sends, so
// they always time out. Talk to the socket directly with emitWithAck and
// unwrap the { error, statusCode, message, data } envelope.
export async function wsRequest(messaging, event, payload = {}, ms = 10_000) {
  const socket = messaging.socket
  if (!socket) throw new Error('messaging socket is not connected')
  let res
  try {
    res = await socket.timeout(ms).emitWithAck(event, payload)
  } catch {
    throw new Error(`${event} timed out after ${ms / 1000}s`)
  }
  if (res?.error) throw new Error(`${event} failed: ${res.message}`)
  return res?.data
}
