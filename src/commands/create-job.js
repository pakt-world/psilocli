import { parseCommand, resolveConfig } from '../config.js'
import { cliInit, sdkOk } from '../client.js'
import { signAndBroadcast } from '../chains.js'
import { sleep } from '../messaging.js'
import { out, print, note, fail } from '../output.js'

export const usage =
  'psilocli create-job --title <t> --amount <n> --invite <0x> [--description <t>] [--currency <s>] [--chain-id <id>] [--asset <0x>] [--deliverable <t> ...]'

const DEFAULTS = {
  description:
    process.env.JOB_DESCRIPTION ??
    'A task created programmatically by an agent buyer.',
  amount: process.env.JOB_AMOUNT ?? '1',
  currency: process.env.JOB_CURRENCY ?? '',
  chainId: process.env.JOB_CHAIN_ID ?? '43113',
  asset: process.env.JOB_ASSET ?? '',
  deliverable:
    process.env.JOB_DELIVERABLE ??
    'Send the buyer a message confirming job acceptance and your readiness to deliver.',
}

async function resolveUserIdByAddress(baseUrl, address) {
  const res = await fetch(
    `${baseUrl}/v1/account-public/by-wallet/${encodeURIComponent(address)}`,
  )
  if (!res.ok) throw new Error(`by-wallet lookup failed: ${res.status}`)
  const body = await res.json()
  const userId = body?.data?._id ?? body?._id
  if (!userId) throw new Error(`No user found for address ${address}`)
  return String(userId)
}

export async function createJobAndInvite(sdk, config, inviteeAddress, params) {
  note(`Resolving user ID for invitee address: ${inviteeAddress}`)
  const inviteeUserId = await resolveUserIdByAddress(config.url, inviteeAddress)
  note(`Invitee user ID: ${inviteeUserId}`)

  const createDto = {
    title: params.title,
    description: params.description,
    amount: params.amount,
    chainId: params.chainId,
    ...(params.currency ? { currency: params.currency } : {}),
    ...(params.asset ? { asset: params.asset } : {}),
    deliverables: params.deliverables.map(d => ({ name: d })),
  }

  if (!params.asset)
    note('Warning: --asset not provided — job will use native coin (AVAX on Fuji). Pass --asset <token-address> or set JOB_ASSET to use an ERC-20.')

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
    const approveTxHash = await signAndBroadcast(config.key, approveTx)
    note(`Approve tx confirmed — txHash: ${approveTxHash}`)
  }

  // Step 4: sign deposit tx.
  if (depositData?.deposit) {
    note('Signing deposit tx...')
    const depositTx = {
      ...depositData.deposit,
      chainId: depositData.deposit.chainId ?? depositData.chainId,
    }
    const depositTxHash = await signAndBroadcast(config.key, depositTx)
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
  note(`Inviting ${inviteeAddress} (userId: ${inviteeUserId}) to job ${jobId}...`)
  const inviteData = sdkOk(
    await sdk.job.inviteTalent(jobId, { inviteeId: inviteeUserId }),
    'inviteTalent',
  )

  if (inviteData?.invitePayload) {
    const tx = inviteData.invitePayload
    note(`Signing onInvite tx for chain ${tx.chainId}...`)
    const txHash = await signAndBroadcast(config.key, tx)
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

  note(`Invite sent to ${inviteeAddress} for job "${params.title}" (${jobId})`)
  return { jobId, inviteeAddress, inviteeUserId }
}

export async function run(argv) {
  const { values } = parseCommand(argv, {
    title: { type: 'string' },
    description: { type: 'string' },
    amount: { type: 'string' },
    currency: { type: 'string' },
    'chain-id': { type: 'string' },
    asset: { type: 'string' },
    deliverable: { type: 'string', multiple: true },
    invite: { type: 'string' },
  })
  const inviteeAddress = values.invite ?? process.env.INVITE_AGENT_ADDRESS
  if (!inviteeAddress)
    fail('--invite <address> is required (or set INVITE_AGENT_ADDRESS)', 2)
  if (!values.title) fail('--title is required', 2)

  const config = resolveConfig(values)
  const { sdk } = await cliInit(config)
  const result = await createJobAndInvite(sdk, config, inviteeAddress, {
    title: values.title,
    description: values.description ?? DEFAULTS.description,
    amount: values.amount ?? DEFAULTS.amount,
    currency: values.currency ?? DEFAULTS.currency,
    chainId: values['chain-id'] ?? DEFAULTS.chainId,
    asset: values.asset ?? DEFAULTS.asset,
    deliverables: values.deliverable ?? [DEFAULTS.deliverable],
  })
  if (config.json) out({ ok: true, ...result })
  else print(`Job created and invite sent — jobId: ${result.jobId}`)
}
