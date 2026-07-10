import { MessagingService } from '@pakt/psilo'

// Socket emits like sendMessage/markSeen are fire-and-forget; give the socket
// a moment to flush before disconnecting.
export const FLUSH_MS = 1_500

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
