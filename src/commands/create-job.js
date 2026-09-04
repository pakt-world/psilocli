import { parseCommand, resolveConfig } from '../config.js'
import { cliInit, sdkOk } from '../client.js'
import { signAndBroadcast, resolveRpc } from '../chains.js'
import { sleep } from '../messaging.js'
import { out, print, note, fail } from '../output.js'

export const usage =
  'psilocli create-job --title <t> --amount <n> [--invite <0x> | --invite-id <userId>] [--description <t>]\n' +
  '                    [--coin <symbol>] [--currency <s>] [--chain-id <id>]\n' +
  '                    [--deliverable <t> ...] [--rpc <url>]\n' +
  'psilocli create-job --resume <jobId> [--invite <0x> | --invite-id <userId>] [--rpc <url>]  Resume a crashed create-job flow'

const DEFAULTS = {
  description:
    process.env.JOB_DESCRIPTION ??
    'A task created programmatically by an agent buyer.',
  amount:      process.env.JOB_AMOUNT      ?? '1',
  coin:        process.env.JOB_COIN        ?? '',
  currency:    process.env.JOB_CURRENCY    ?? '',
  chainId:     process.env.JOB_CHAIN_ID    ?? '',   // empty → query server active RPC
  deliverable:
    process.env.JOB_DELIVERABLE ??
    'Send the buyer a message confirming job acceptance and your readiness to deliver.',
}

async function resolveUserIdByAddress(sdk, address) {
  const result = sdkOk(await sdk.user.getUserByWalletAddress(address), 'user.getUserByWalletAddress')
  const userId = result?._id
  if (!userId) throw new Error(`No user found for address ${address}`)
  return String(userId)
}

export async function createJobAndInvite(sdk, config, inviteeAddress, params, inviteeUserIdOverride = null, rpcOverride = null) {
  let inviteeUserId
  if (inviteeUserIdOverride) {
    // Validate the user ID exists before touching the chain.
    sdkOk(await sdk.user.getUserById(inviteeUserIdOverride), 'user.getUserById')
    note(`Invitee user ID verified: ${inviteeUserIdOverride}`)
    inviteeUserId = inviteeUserIdOverride
  } else {
    note(`Resolving user ID for invitee address: ${inviteeAddress}`)
    inviteeUserId = await resolveUserIdByAddress(sdk, inviteeAddress)
    note(`Invitee user ID: ${inviteeUserId}`)
  }

  const createDto = {
    title: params.title,
    description: params.description,
    amount: params.amount,
    chainId: params.chainId,
    ...(params.currency ? { currency: params.currency } : {}),
    ...(params.asset ? { asset: params.asset } : {}),
    deliverables: params.deliverables.map(d => ({ name: d })),
  }

  // Step 1: create the job record.
  note(`Creating job: "${params.title}"`)
  const createData = sdkOk(await sdk.job.create(createDto), 'job.create')
  const job = createData?.job ?? createData
  const jobId = String(job._id)
  note(`Job created — jobId: ${jobId}`)

  // Step 2: server creates the escrow on-chain and returns deposit/approve txs.
  note('Calling makeDeposit to prepare escrow...')
  const depositData = sdkOk(await sdk.job.makeDeposit(jobId), 'makeDeposit')
  note(
    `Escrow address: ${depositData?.escrowAddress} — amount: ${depositData?.coinAmount} ${depositData?.coinSymbol}`,
  )

  // Step 3: sign approve tx (ERC-20 only). signAndBroadcast waits for one
  // confirmation, so the approve is mined before the deposit is sent.
  if (depositData?.approve) {
    note('Signing ERC-20 approve tx...')
    const approveTx = {
      ...depositData.approve,
      chainId: depositData.approve.chainId ?? depositData.chainId,
    }
    const approveTxHash = await signAndBroadcast(sdk, config.key, approveTx, rpcOverride)
    note(`Approve tx confirmed — txHash: ${approveTxHash}`)
  }

  // Step 4: sign deposit tx.
  if (depositData?.deposit) {
    note('Signing deposit tx...')
    const depositTx = {
      ...depositData.deposit,
      chainId: depositData.deposit.chainId ?? depositData.chainId,
    }
    const depositTxHash = await signAndBroadcast(sdk, config.key, depositTx, rpcOverride)
    note(`Deposit tx confirmed — txHash: ${depositTxHash}`)
  }

  // Step 5: validate payment on-chain; retries cover indexing lag.
  let validated = false
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      sdkOk(await sdk.job.validatePayment(jobId), 'validatePayment')
      validated = true
      note(`Escrow funded and validated (attempt ${attempt})`)
      break
    } catch (err) {
      note(`validatePayment attempt ${attempt}/6 failed: ${err.message}`)
      if (attempt < 6) await sleep(10_000)
    }
  }
  if (!validated) {
    throw new Error(
      'Escrow deposit could not be confirmed after 6 attempts — aborting invite',
    )
  }

  // Step 6: send the invite; sign the invite tx if escrow-locked.
  const inviteRef = inviteeAddress ?? inviteeUserId
  note(`Inviting ${inviteRef} to job ${jobId}...`)
  const inviteData = sdkOk(
    await sdk.job.inviteTalent(jobId, { inviteeId: inviteeUserId }),
    'inviteTalent',
  )

  if (inviteData?.invitePayload) {
    const tx = inviteData.invitePayload
    note(`Signing onInvite tx for chain ${tx.chainId}...`)
    const txHash = await signAndBroadcast(sdk, config.key, tx, rpcOverride)
    sdkOk(
      await sdk.job.confirmTx(jobId, {
        step: 'onInvite',
        txHash,
        inviteeId: inviteeUserId,
      }),
      'confirmTx onInvite',
    )
    note(`confirmTx onInvite — txHash: ${txHash}`)
  }

  note(`Invite sent to ${inviteRef} for job "${params.title}" (${jobId})`)
  return { jobId, inviteeAddress, inviteeUserId }
}

async function resumeJob(sdk, config, jobId, inviteeAddress, rpcOverride = null) {
  note('WARNING: Multi-step on-chain flow (~60s). Do not interrupt or wrap in a timeout.')

  const jobData = sdkOk(await sdk.job.getById(jobId), 'job.getById')
  const job = jobData?.job ?? jobData

  if (['cancelled', 'completed'].includes(job.status))
    fail(`Job ${jobId} is "${job.status}" — nothing to resume.`, 1)

  note(`Resuming job "${job.title}" (status: ${job.status})`)

  const escrowData = sdkOk(await sdk.job.getEscrowStatus(jobId), 'job.getEscrowStatus')
  const onChain = escrowData?.onChain ?? {}

  if (!onChain.deposited) {
    note('Escrow not funded — resuming from deposit step')
    const depositData = sdkOk(await sdk.job.makeDeposit(jobId), 'makeDeposit')
    note(`Escrow address: ${depositData?.escrowAddress} — amount: ${depositData?.coinAmount} ${depositData?.coinSymbol}`)

    if (depositData?.approve) {
      note('Signing ERC-20 approve tx...')
      const approveTx = { ...depositData.approve, chainId: depositData.approve.chainId ?? depositData.chainId }
      const approveTxHash = await signAndBroadcast(sdk, config.key, approveTx, rpcOverride)
      note(`Approve tx confirmed — txHash: ${approveTxHash}`)
    }

    if (depositData?.deposit) {
      note('Signing deposit tx...')
      const depositTx = { ...depositData.deposit, chainId: depositData.deposit.chainId ?? depositData.chainId }
      const depositTxHash = await signAndBroadcast(sdk, config.key, depositTx, rpcOverride)
      note(`Deposit tx confirmed — txHash: ${depositTxHash}`)
    }

    let validated = false
    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        sdkOk(await sdk.job.validatePayment(jobId), 'validatePayment')
        validated = true
        note(`Escrow funded and validated (attempt ${attempt})`)
        break
      } catch (err) {
        note(`validatePayment attempt ${attempt}/6 failed: ${err.message}`)
        if (attempt < 6) await sleep(10_000)
      }
    }
    if (!validated)
      throw new Error('Escrow deposit could not be confirmed after 6 attempts — aborting invite')
  } else {
    note('Escrow already funded — skipping deposit step')
  }

  // If invite was already accepted, nothing left to do.
  if (['ongoing', 'review', 'completed'].includes(job.status)) {
    note(`Job already has status "${job.status}" — invite step already complete.`)
    return { jobId, resumed: true }
  }

  if (!inviteeAddress)
    fail('Escrow is funded but no invite sent. Provide --invite <address> to complete resume.', 2)

  const inviteeUserId = await resolveUserIdByAddress(sdk, inviteeAddress)
  note(`Inviting ${inviteeAddress} (userId: ${inviteeUserId}) to job ${jobId}...`)
  const inviteData = sdkOk(
    await sdk.job.inviteTalent(jobId, { inviteeId: inviteeUserId }),
    'inviteTalent',
  )

  if (inviteData?.invitePayload) {
    const tx = inviteData.invitePayload
    note(`Signing onInvite tx for chain ${tx.chainId}...`)
    const txHash = await signAndBroadcast(sdk, config.key, tx, rpcOverride)
    sdkOk(
      await sdk.job.confirmTx(jobId, { step: 'onInvite', txHash, inviteeId: inviteeUserId }),
      'confirmTx onInvite',
    )
    note(`confirmTx onInvite — txHash: ${txHash}`)
  }

  note(`Invite sent to ${inviteeAddress} for job ${jobId}`)
  return { jobId, resumed: true }
}

export async function run(argv) {
  const { values } = parseCommand(argv, {
    title:        { type: 'string' },
    description:  { type: 'string' },
    amount:       { type: 'string' },
    coin:         { type: 'string' },
    currency:     { type: 'string' },
    'chain-id':   { type: 'string' },
    deliverable:  { type: 'string', multiple: true },
    invite:       { type: 'string' },
    'invite-id':  { type: 'string' },
    resume:       { type: 'string' },
    rpc:          { type: 'string' },
  })
  const inviteeAddress = values.invite ?? process.env.INVITE_AGENT_ADDRESS
  const inviteeIdDirect = values['invite-id'] ?? null
  const rpcOverride = values.rpc ?? null

  // --resume: skip creation, pick up from the right checkpoint
  if (values.resume) {
    const config = resolveConfig(values)
    const { sdk } = await cliInit(config)
    const result = await resumeJob(sdk, config, values.resume, inviteeAddress, rpcOverride)
    if (config.json) out({ ok: true, ...result })
    else print(`Job ${result.jobId} resumed successfully`)
    return
  }

  if (!inviteeAddress && !inviteeIdDirect)
    fail('--invite <address> or --invite-id <userId> is required (or set INVITE_AGENT_ADDRESS)', 2)
  if (!values.title) fail('--title is required', 2)

  const config = resolveConfig(values)
  const { sdk } = await cliInit(config)

  // --- resolve coin → asset + currency + chainId ---
  // asset can only come from --coin below — there's no raw override, so it's
  // never at odds with the coin lookup (see PSILO-6).
  const amount = values.amount ?? DEFAULTS.amount
  let asset    = ''
  let currency = values.currency ?? DEFAULTS.currency
  let chainId  = values['chain-id'] || null

  const coinSymbol = values.coin ?? DEFAULTS.coin
  if (coinSymbol) {
    const allCoins = sdkOk(await sdk.payment.fetchPaymentCoins(), 'payment.fetchPaymentCoins')
    const coin = (Array.isArray(allCoins) ? allCoins : []).find(
      c => c.active && c.symbol.toLowerCase() === coinSymbol.toLowerCase(),
    )
    if (!coin)
      fail(
        `Coin "${coinSymbol}" not found or inactive.\n` +
        'Run "psilocli list coins" to see available options.',
        2,
      )
    // Validate before job.create() — the server only enforces this later, in
    // makeDeposit, by which point the (unfunded) job record already exists
    // and has to be cleaned up with delete-job (see PSILO-8).
    if (coin.minAmount != null && Number(amount) < Number(coin.minAmount))
      fail(
        `Amount ${amount} is below ${coin.symbol}'s minimum of ${coin.minAmount}.\n` +
        'Run "psilocli list coins --json" to check minimums before creating a job.',
        2,
      )
    currency = coin._id
    if (!chainId) {
      chainId = String((coin.rpcChainIds ?? [])[0] ?? '')
    } else if (!(coin.rpcChainIds ?? []).map(String).includes(String(chainId))) {
      note(`WARNING: --chain-id ${chainId} not in ${coin.symbol} chains (${(coin.rpcChainIds ?? []).join(', ')}). Using coin's first chain.`)
      chainId = String((coin.rpcChainIds ?? [])[0] ?? '')
    }
    asset = coin.isToken ? (coin.contractAddresses?.[chainId] ?? coin.contractAddress ?? '') : ''
    note(`Coin: ${coin.name} (${coin.symbol})${coin.isToken ? ` — contract ${asset}` : ' — native'}`)
  }

  if (!chainId) {
    if (DEFAULTS.chainId) {
      chainId = DEFAULTS.chainId
    } else {
      const { chainId: defaultChainId, name: chainName } = await resolveRpc(sdk, null)
      chainId = defaultChainId
      note(`Default chain: ${chainName} (chainId ${chainId})`)
    }
  }
  // -------------------------------------------------

  note('WARNING: Multi-step on-chain flow (~60s). Do not interrupt or wrap in a timeout.')
  const result = await createJobAndInvite(sdk, config, inviteeAddress, {
    title:       values.title,
    description: values.description ?? DEFAULTS.description,
    amount,
    currency,
    chainId,
    asset,
    deliverables: values.deliverable ?? [DEFAULTS.deliverable],
  }, inviteeIdDirect, rpcOverride)
  if (config.json) out({ ok: true, ...result })
  else print(`Job created and invite sent — jobId: ${result.jobId}`)
}
