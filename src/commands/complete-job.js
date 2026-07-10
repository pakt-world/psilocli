import { readFileSync } from 'node:fs'
import { parseCommand, resolveConfig } from '../config.js'
import { cliInit, sdkOk } from '../client.js'
import { signAndBroadcast } from '../chains.js'
import { withMessaging, withTimeout, sleep, FLUSH_MS } from '../messaging.js'
import { out, print, note, fail } from '../output.js'

export const usage =
  'psilocli complete-job <jobId> [--content <text> | --content-file <path>]'

// A deliverable whose title/description asks the seller to message the buyer.
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

async function sendToCreator(messaging, creatorId, content) {
  const convo = await withTimeout(
    messaging.createDirectConversation(creatorId),
    10_000,
    'createDirectConversation',
  )
  messaging.sendMessage({
    conversationId: convo._id,
    type: 'TEXT',
    message: content,
  })
  await sleep(FLUSH_MS)
  note(`Message sent to creator in conversation ${convo._id}`)
}

export async function run(argv) {
  const { values, positionals } = parseCommand(
    argv,
    {
      content: { type: 'string' },
      'content-file': { type: 'string' },
    },
    { positionals: true },
  )
  const jobId = positionals[0]
  if (!jobId) fail(`Usage: ${usage}`, 2)
  let content = values.content ?? null
  if (!content && values['content-file'])
    content = readFileSync(values['content-file'], 'utf8').trim()

  const config = resolveConfig(values)
  const { sdk, jwt } = await cliInit(config)

  const jobData = sdkOk(await sdk.job.getById(jobId), 'getById')
  const job = jobData?.job ?? jobData

  const jobSeller = (job.seller ?? '').toLowerCase()
  if (jobSeller && jobSeller !== config.address.toLowerCase())
    fail(`Not the seller of "${job.title}" (seller: ${jobSeller})`)

  const allDeliverables = job.deliverables ?? []
  const pending = allDeliverables.filter((d) => d.status !== 'completed')
  note(
    `Job "${job.title}" — ${pending.length}/${allDeliverables.length} deliverable(s) pending`,
  )

  const messagingPending = pending.filter(isMessagingDeliverable)
  if (messagingPending.length > 0 && !content)
    fail(
      `Deliverable "${messagingPending[0].title}" requires sending a message — provide --content or --content-file`,
      2,
    )

  const completeDeliverables = async (messaging) => {
    const creatorId = String(job.creator?._id ?? job.creator ?? '')
    for (const deliverable of pending) {
      if (isMessagingDeliverable(deliverable) && messaging) {
        if (creatorId) {
          await sendToCreator(messaging, creatorId, content)
        } else {
          note(
            `Messaging deliverable "${deliverable.title}" but creator ID unknown — skipping send`,
          )
        }
      }
      sdkOk(
        await sdk.job.toggleDeliverableProgress(
          jobId,
          String(deliverable._id),
          { status: 'completed' },
        ),
        'toggleDeliverableProgress',
      )
      note(`Deliverable "${deliverable.title}" marked complete`)
    }
  }

  if (messagingPending.length > 0) {
    await withMessaging(config, jwt, completeDeliverables)
  } else {
    await completeDeliverables(null)
  }

  // Re-fetch and verify nothing pending before completing the job.
  const refreshed = sdkOk(
    await sdk.job.getById(jobId),
    'getById (pre-complete check)',
  )
  const refreshedJob = refreshed?.job ?? refreshed
  const stillPending = (refreshedJob?.deliverables ?? []).filter(
    (d) => d.status !== 'completed',
  )
  if (stillPending.length > 0)
    fail(`${stillPending.length} deliverable(s) still incomplete — aborting completeJob`)

  note('All deliverables confirmed complete — completing job')
  const completeData = sdkOk(await sdk.job.completeJob(jobId, {}), 'completeJob')

  let txHash = null
  const { markReadyPayload } = completeData
  if (markReadyPayload) {
    note(`Signing markReady tx for chain ${markReadyPayload.chainId}...`)
    txHash = await signAndBroadcast(config.key, markReadyPayload)
    note(`markReady broadcast — txHash: ${txHash} — confirming with API...`)

    let confirmed = false
    for (let attempt = 1; attempt <= 6; attempt++) {
      await sleep(10_000)
      try {
        sdkOk(
          await sdk.job.confirmTx(jobId, { step: 'onMarkReady', txHash }),
          'confirmTx onMarkReady',
        )
        note(`Job marked ready on-chain (attempt ${attempt})`)
        confirmed = true
        break
      } catch (err) {
        note(`confirmTx onMarkReady attempt ${attempt}/6 failed: ${err.message}`)
      }
    }
    if (!confirmed)
      fail(`confirmTx onMarkReady exhausted retries — txHash: ${txHash}`)
  } else {
    note('Job completed (off-chain)')
  }

  if (config.json) out({ ok: true, jobId, txHash })
  else print(txHash ? `Job ${jobId} complete — txHash: ${txHash}` : `Job ${jobId} complete`)
}
