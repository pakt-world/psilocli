import { readFileSync } from 'node:fs'
import { parseCommand, resolveConfig } from '../config.js'
import { cliInit, sdkOk } from '../client.js'
import { signAndBroadcast } from '../chains.js'
import { withMessaging, wsRequest } from '../messaging.js'
import { out, print, note, fail } from '../output.js'

export const usage =
  'psilocli complete-job <jobId> [--content <text> | --content-file <path>] [--rpc <url>]'

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
  const data = await wsRequest(messaging, 'INITIALIZE_CONVERSATION', {
    type: 'DIRECT',
    recipientId: creatorId,
  })
  const convId = (data?.conversation ?? data)?._id
  if (!convId) throw new Error('Could not open a conversation with the creator')
  await wsRequest(messaging, 'SEND_MESSAGE', {
    conversationId: convId,
    type: 'TEXT',
    message: content,
  })
  note(`Message sent to creator in conversation ${convId}`)
}

export async function run(argv) {
  const { values, positionals } = parseCommand(
    argv,
    {
      content: { type: 'string' },
      'content-file': { type: 'string' },
      rpc: { type: 'string' },
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

  // Pre-flight the status before touching a single deliverable: the server
  // refuses completeJob for anything but an in-progress job, and 0.2.6 only
  // found that out after marking deliverables and logging "completing job".
  if (job.status !== 'ongoing')
    fail(`Job "${job.title}" is ${job.status ?? 'unknown'}; only a job in progress (ongoing) can be marked complete. Nothing changed.`)

  const allDeliverables = job.deliverables ?? []
  if (allDeliverables.length === 0)
    note('No deliverables on this job — skipping deliverable completion step.')
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
      // Attach the content as an on-record artifact so the buyer can verify
      // the work before releasing payment.
      sdkOk(
        await sdk.job.toggleDeliverableProgress(
          jobId,
          String(deliverable._id),
          { status: 'completed', comment: content ?? '' },
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

  const completeData = sdkOk(await sdk.job.completeJob(jobId, content ? { note: content } : {}), 'completeJob')
  note(`Job accepted by server — ${allDeliverables.length} deliverable(s) recorded`)

  let txHash = null
  const { markReadyPayload } = completeData
  if (markReadyPayload) {
    note(`Signing markReady tx for chain ${markReadyPayload.chainId}...`)
    txHash = await signAndBroadcast(sdk, config.key, markReadyPayload, values.rpc ?? null)
    note(`markReady broadcast — txHash: ${txHash} — confirming with API...`)

    sdkOk(
      await sdk.job.confirmTx(jobId, { step: 'onMarkReady', txHash }, {
        onRetry: ({ attempt, attempts, message }) =>
          note(`confirmTx onMarkReady attempt ${attempt}/${attempts} failed: ${message}`),
      }),
      'confirmTx onMarkReady',
    )
    note('Job marked ready on-chain')
  } else {
    note('Job completed (off-chain)')
  }

  if (config.json) out({ ok: true, jobId, txHash })
  else print(txHash ? `Job ${jobId} complete — txHash: ${txHash}` : `Job ${jobId} complete`)
}
