import { parseCommand, resolveConfig } from '../config.js'
import { cliInit, sdkOk } from '../client.js'
import { out, print, fail, cliTable } from '../output.js'

export const usage =
  'psilocli list jobs [--status <s>] [--limit <n>] [--role <r>]\n' +
  'psilocli list invites\n' +
  'psilocli list users [--search <text>] [--tags <t>] [--username <s>] [--role <r>] [--limit <n>] [--page <n>]\n' +
  'psilocli list chains\n' +
  'psilocli list coins [--chain-id <n>]'

export async function run(argv) {
  const sub = argv[0]

  if (sub === 'jobs') {
    const { values } = parseCommand(argv.slice(1), {
      status: { type: 'string' },
      limit: { type: 'string' },
      role: { type: 'string' },
    })
    const config = resolveConfig(values)
    const { sdk } = await cliInit(config)
    const role = values.role ?? 'buyer'
    if (!values.role)
      process.stderr.write('note: defaulting to --role buyer. Pass --role seller to see seller jobs.\n')
    const listOpts = {
      status: values.status ?? 'open',
      limit: parseInt(values.limit ?? '20', 10),
      role,
    }
    const result = sdkOk(await sdk.job.list(listOpts), 'job.list')
    const jobs = result?.data ?? (Array.isArray(result) ? result : [])
    if (config.json) {
      out(jobs)
    } else if (jobs.length === 0) {
      print('No jobs found.')
    } else {
      cliTable(
        jobs.map((j) => [
          String(j._id).slice(-8),
          (j.title ?? '').slice(0, 40),
          j.status ?? '',
          String(j.amount ?? ''),
          j.currency?.symbol ?? 'AVAX',
        ]),
        ['ID', 'Title', 'Status', 'Amount', 'Token'],
      )
    }
    return
  }

  if (sub === 'invites') {
    const { values } = parseCommand(argv.slice(1))
    const config = resolveConfig(values)
    const { sdk } = await cliInit(config)
    const { data: inviteList } = await sdk.job.listAllInvites()
    const invites = inviteList?.data ?? []
    if (config.json) {
      out(invites)
    } else if (invites.length === 0) {
      print('No invites found.')
    } else {
      cliTable(
        invites.map((i) => [
          String(i._id).slice(-8),
          String(i.job?._id ?? i.job ?? '').slice(-8),
          (i.job?.title ?? '').slice(0, 36),
          i.direction ?? '',
          i.status ?? '',
          String(i.sender?._id ?? '').slice(-8),
        ]),
        ['ID', 'Job ID', 'Job Title', 'Dir', 'Status', 'From'],
      )
      // Warn when multiple pending invites share the same sender (duplicate buyer)
      const pendingBySender = {}
      for (const i of invites) {
        if (i.status !== 'pending') continue
        const senderId = String(i.sender?._id ?? '')
        if (!senderId) continue
        pendingBySender[senderId] = (pendingBySender[senderId] ?? 0) + 1
      }
      const duplicates = Object.entries(pendingBySender).filter(([, n]) => n > 1)
      if (duplicates.length > 0)
        process.stderr.write(
          `note: ${duplicates.length} buyer(s) sent multiple pending invites — check Job ID column before accepting.\n`,
        )
    }
    return
  }

  if (sub === 'users') {
    const { values } = parseCommand(argv.slice(1), {
      search:   { type: 'string' },
      tags:     { type: 'string' },
      limit:    { type: 'string' },
      page:     { type: 'string' },
      username: { type: 'string' },
      role:     { type: 'string' },
    })
    const config = resolveConfig(values)
    const { sdk } = await cliInit(config)

    const query = {}
    if (values.search)   query.search   = values.search
    if (values.tags)     query.tags     = values.tags
    if (values.limit)    query.limit    = parseInt(values.limit, 10)
    if (values.page)     query.page     = parseInt(values.page, 10)
    if (values.username) query.userName = values.username
    if (values.role)     query.role     = values.role

    const result = sdkOk(await sdk.user.searchUsers(query), 'user.searchUsers')
    const users = result?.data ?? (Array.isArray(result) ? result : [])

    if (config.json) {
      out(users)
    } else if (users.length === 0) {
      print('No users found.')
    } else {
      cliTable(
        users.map((u) => [
          String(u._id).slice(-12),
          `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim(),
          u.userName ?? '',
          String(u.score ?? 0),
          (u.tags ?? []).slice(0, 4).join(', '),
        ]),
        ['ID', 'Name', 'Username', 'Score', 'Tags'],
      )
    }
    return
  }

  if (sub === 'chains') {
    const { values } = parseCommand(argv.slice(1))
    const config = resolveConfig(values)
    const { sdk } = await cliInit(config)
    const rpc = sdkOk(await sdk.payment.fetchActiveRpc(), 'payment.fetchActiveRpc')
    if (config.json) {
      out(rpc)
    } else if (!rpc) {
      print('No active RPC configured on this server.')
    } else {
      cliTable(
        [[
          String(rpc.rpcChainId),
          rpc.rpcName,
          rpc.rpcNativeCurrency?.symbol ?? '',
          rpc.rpcType ?? '',
          (rpc.rpcUrls ?? []).slice(0, 2).join(', ').slice(0, 60),
        ]],
        ['Chain ID', 'Name', 'Native', 'Type', 'RPC URLs'],
      )
    }
    return
  }

  if (sub === 'coins') {
    const { values } = parseCommand(argv.slice(1), {
      'chain-id': { type: 'string' },
    })
    const config = resolveConfig(values)
    const { sdk } = await cliInit(config)
    const allCoins = sdkOk(await sdk.payment.fetchPaymentCoins(), 'payment.fetchPaymentCoins')
    let coins = (Array.isArray(allCoins) ? allCoins : []).filter(c => c.active)
    if (values['chain-id']) {
      const id = parseInt(values['chain-id'], 10)
      coins = coins.filter(c => c.rpcChainId === id)
    }
    if (config.json) {
      out(coins)
    } else if (coins.length === 0) {
      print('No active coins found.')
    } else {
      cliTable(
        coins.map(c => [
          c.symbol,
          c.name,
          c.isToken ? 'ERC-20' : 'Native',
          c.isToken
            ? `${(c.contractAddress ?? '').slice(0, 10)}…${(c.contractAddress ?? '').slice(-4)}`
            : '—',
          String(c.rpcChainId),
        ]),
        ['Symbol', 'Name', 'Type', 'Contract', 'Chain ID'],
      )
    }
    return
  }

  fail(`Usage: ${usage}`, 2)
}
