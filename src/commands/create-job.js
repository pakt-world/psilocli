import { parseArgs } from 'node:util'
import { sdkOk, resolveUserIdByAddress } from '../client.js'
import { signAndBroadcast } from '../chains.js'
import { out, fail } from '../output.js'

async function createJobAndInvite(config, sdk, inviteeAddress, params = {}) {
  const jobTitle       = params.title       ?? 'Agent-to-Agent Task'
  const jobDescription = params.description ?? ''
  const jobAmount      = params.amount      ?? '1'
  const jobChainId     = params.chainId     ?? '43113'
  const jobAsset       = params.asset       ?? ''
  const jobDeliverable = params.deliverable ?? ''

  const inviteeUserId = await resolveUserIdByAddress(config, inviteeAddress)

  const deliverables = jobDeliverable ? [{ name: jobDeliverable }] : []

  const createDto = {
    title: jobTitle,
    description: jobDescription,
    amount: jobAmount,
    chainId: jobChainId,
    ...(jobAsset ? { asset: jobAsset } : {}),
    deliverables,
  }

  // Step 1: Create job record
  const createData = sdkOk(await sdk.job.create(createDto), 'job.create')
  const job = createData?.job ?? createData
  const jobId = String(job._id)
  process.stderr.write(`Job created — jobId: ${jobId}\n`)

  // Step 2: Prepare escrow deposit
  const depositData = sdkOk(await sdk.job.makeDeposit(jobId), 'makeDeposit')
  process.stderr.write(
    `Escrow address: ${depositData?.escrowAddress} — amount: ${depositData?.coinAmount} ${depositData?.coinSymbol}\n`,
  )

  // Step 3: Sign approve tx (ERC-20 only)
  // No sleep after approve — signAndBroadcast calls tx.wait() for one-block confirmation.
  if (depositData?.approve) {
    process.stderr.write('Signing ERC-20 approve tx...\n')
    const approveTx = {
      ...depositData.approve,
      chainId: depositData.approve.chainId ?? depositData.chainId,
    }
    const approveTxHash = await signAndBroadcast(approveTx, config.key)
    process.stderr.write(`Approve tx broadcast — txHash: ${approveTxHash}\n`)
  }

  // Step 4: Sign deposit tx
  // No sleep after deposit — validatePayment retry loop handles indexing lag.
  if (depositData?.deposit) {
    process.stderr.write('Signing deposit tx...\n')
    const depositTx = {
      ...depositData.deposit,
      chainId: depositData.deposit.chainId ?? depositData.chainId,
    }
    const depositTxHash = await signAndBroadcast(depositTx, config.key)
    process.stderr.write(`Deposit tx broadcast — txHash: ${depositTxHash}\n`)
  }

  // Step 5: Validate payment on-chain (6 attempts, 10s apart)
  let validated = false
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      sdkOk(await sdk.job.validatePayment(jobId), 'validatePayment')
      validated = true
      process.stderr.write(`Escrow funded and validated (attempt ${attempt})\n`)
      break
    } catch (err) {
      process.stderr.write(
        `validatePayment attempt ${attempt}/6 failed: ${err.message}\n`,
      )
      if (attempt < 6) await new Promise((r) => setTimeout(r, 10_000))
    }
  }
  if (!validated) {
    throw new Error(
      'Escrow deposit could not be confirmed after 6 attempts — aborting invite',
    )
  }

  // Step 6: Send invite
  const inviteData = sdkOk(
    await sdk.job.inviteTalent(jobId, { inviteeId: inviteeUserId }),
    'inviteTalent',
  )

  if (inviteData?.invitePayload) {
    const tx = inviteData.invitePayload
    const txHash = await signAndBroadcast(tx, config.key)
    sdkOk(
      await sdk.job.confirmTx(jobId, { step: 'onInvite', txHash, inviteeId: inviteeUserId }),
      'confirmTx onInvite',
    )
    process.stderr.write(`confirmTx onInvite — txHash: ${txHash}\n`)
  }

  process.stderr.write(
    `Invite sent to ${inviteeAddress} for job "${jobTitle}" (${jobId})\n`,
  )
  return { jobId, inviteeAddress, inviteeUserId }
}

export async function cmdCreateJob(config, { sdk }, args) {
  const { values: flags } = parseArgs({
    args,
    options: {
      title:       { type: 'string' },
      description: { type: 'string' },
      amount:      { type: 'string' },
      'chain-id':  { type: 'string' },
      asset:       { type: 'string' },
      deliverable: { type: 'string' },
      invite:      { type: 'string' },
    },
    strict: true,
  })

  const inviteeAddress = flags.invite ?? process.env.INVITE_AGENT_ADDRESS
  if (!inviteeAddress) fail('--invite <address> is required', 2)

  if (!flags.title) fail('--title is required', 2)

  const result = await createJobAndInvite(config, sdk, inviteeAddress, {
    title:       flags.title,
    description: flags.description,
    amount:      flags.amount,
    chainId:     flags['chain-id'],
    asset:       flags.asset,
    deliverable: flags.deliverable,
  })

  if (config.json) out({ ok: true, ...result })
  else process.stdout.write(`Job created and invite sent — jobId: ${result.jobId}\n`)
}
