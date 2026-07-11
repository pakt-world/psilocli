import { MessagingService } from '@pakt/psilo'

export async function withMessaging({ url, jwt }, fn) {
  const messaging = new MessagingService(url, jwt)
  await Promise.race([
    messaging.connect(),
    new Promise((_, r) =>
      setTimeout(() => r(new Error('Messaging connect timed out after 10s')), 10_000),
    ),
  ])
  try {
    return await fn(messaging)
  } finally {
    try { messaging.disconnect() } catch {}
  }
}
