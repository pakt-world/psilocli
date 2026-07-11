import { parseArgs } from 'node:util'
import { readFileSync } from 'fs'
import { sdkOk } from '../client.js'
import { signAndBroadcast } from '../chains.js'
import { withMessaging } from '../messaging.js'
import { out, fail } from '../output.js'

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

async function runJob(config, sdk, jobId, content) {
  const jobData = sdkOk(await sdk.job.getById(jobId), 'getById')
  const job = jobData?.job ?? jobData

  const jobSeller = (job.seller ?? '').toLowerCase()
  if (jobSeller && jobSeller !== config.address.toLowerCase()) {
    fail(`You are not the seller for job ${jobId} (seller: ${jobSeller})`)
  }

  const allDeliverables = job.deliverables ?? []
  const pending = allDeliverables.filter((d) => d.status !== 'completed')
  process.stderr.write(
    `Job "${job.title}" — ${pending.length}/${allDeliverables.length} deliverable(s) pending\n`,
  )

  // Validate: if any pending deliverable needs messaging, --content must be provided.
  const messagingPending = pending.filter(isMessagingDeliverable)
  if (messagingPending.length > 0 && !content) {
    fail(
      `--content is required for messaging deliverable "${messagingPending[0].title}"`,
      2,
    )
  }

  const needsSocket = messagingPending.length > 0

  const execute = async (messaging) => {
    for (const deliverable of pending) {
      process.stderr.write(`Working on deliverable: "${deliverable.title}"\n`)

      if (isMessagingDeliverable(deliverable) && messaging) {
        const creatorId = String(job.creator?._id ?? job.creator ?? '')
        if (creatorId) {
          const convo = await Promise.race([
            messaging.createDirectConversation(creatorId),
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error('createDirectConversation timed out after 10s')),
                10_000,
              ),
            ),
          ])
          messaging.sendMessage({
            conversationId: convo._id,
            type: 'TEXT',
            message: content,
          })
          process.stderr.write(`Message sent to creator in conversation ${convo._id}\n`)
        } else {
          process.stderr.write('Messaging deliverable but creator ID unknown — skipping send\n')
        }
      }

      sdkOk(
        await sdk.job.toggleDeliverableProgress(
          jobId,
          String(deliverable._id),
          { status: 'completed', comment: content ?? '' },
        ),
        'toggleDeliverableProgress',
      )
      process.stderr.write(`Deliverable "${deliverable.title}" marked complete\n`)
    }

    // Verify nothing still pending before completing
    const refreshed = sdkOk(await sdk.job.getById(jobId), 'getById (pre-complete check)')
    const refreshedJob = refreshed?.job ?? refreshed
    const stillPending = (refreshedJob?.deliverables ?? []).filter(
      (d) => d.status !== 'completed',
    )
    if (stillPending.length > 0) {
      fail(`${stillPending.length} deliverable(s) still incomplete after marking — aborting`)
    }

    process.stderr.write('All deliverables confirmed complete — completing job\n')

    const completeData = sdkOk(await sdk.job.completeJob(jobId, {}), 'completeJob')
    const { markReadyPayload } = completeData

    if (markReadyPayload) {
      process.stderr.write(
        `Signing markReady tx for chain ${markReadyPayload.chainId}...\n`,
      )
      const txHash = await signAndBroadcast(markReadyPayload, config.key)
      process.stderr.write(`markReady broadcast — txHash: ${txHash}\n`)

      let confirmed = false
      for (let attempt = 1; attempt <= 6; attempt++) {
        await new Promise((r) => setTimeout(r, 10_000))
        try {
          sdkOk(
            await sdk.job.confirmTx(jobId, { step: 'onMarkReady', txHash }),
            'confirmTx onMarkReady',
          )
          process.stderr.write(
            `Job marked ready on-chain (attempt ${attempt}) — txHash: ${txHash}\n`,
          )
          confirmed = true
          break
        } catch (err) {
          process.stderr.write(
            `confirmTx onMarkReady attempt ${attempt}/6 failed: ${err.message}\n`,
          )
        }
      }
      if (!confirmed) {
        fail('confirmTx onMarkReady exhausted retries — buyer cannot release until confirmed')
      }
    } else {
      process.stderr.write('Job completed (off-chain)\n')
    }
  }

  if (needsSocket) {
    await withMessaging({ url: config.url, jwt: config._jwt }, execute)
  } else {
    await execute(null)
  }
}

export async function cmdCompleteJob(config, auth, args) {
  const { values: flags, positionals } = parseArgs({
    args,
    options: {
      content:      { type: 'string' },
      'content-file': { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  })

  const jobId = positionals[0]
  if (!jobId) fail('Usage: psilocli complete-job <jobId> [--content "..." | --content-file path]', 2)

  let content = flags.content
  if (!content && flags['content-file']) {
    content = readFileSync(flags['content-file'], 'utf8').trim()
  }

  // Attach jwt to config so withMessaging can use it if needed
  config._jwt = auth.jwt

  await runJob(config, auth.sdk, jobId, content)

  if (config.json) out({ ok: true, jobId })
  else process.stdout.write(`Job ${jobId} complete\n`)
}
