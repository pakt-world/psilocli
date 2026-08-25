import { ethers } from 'ethers'
import { parseCommand, resolveConfig } from '../config.js'
import { cliInit } from '../client.js'
import { fetchActiveRpc, resolveRpc, readTokenBalance } from '../chains.js'
import { out, print, note, fail } from '../output.js'

export const usage = 'psilocli balance [--chain <id>] [--token <0x>]'

export async function run(argv) {
  const { values } = parseCommand(argv, {
    chain: { type: 'string' },
    token: { type: 'string' },
  })
  const config = resolveConfig(values)
  const { sdk } = await cliInit(config)
  let chainId = values.chain
  if (!chainId) {
    const active = await fetchActiveRpc(sdk)
    if (!active?.rpcChainId) {
      fail(
        'No active chain is configured on the server, and --chain was not provided. Pass --chain <id> explicitly before proceeding.',
      )
    }
    chainId = String(active.rpcChainId)
    note(`Active chain: ${active.rpcName ?? chainId} (chainId ${chainId})`)
  }
  const { url: rpcUrl, symbol: nativeSymbol } = await resolveRpc(sdk, chainId)
  const provider = new ethers.JsonRpcProvider(rpcUrl)
  const raw = await provider.getBalance(config.address)
  const result = {
    native: {
      chain: chainId,
      symbol: nativeSymbol ?? 'native',
      balance: ethers.formatEther(raw),
    },
  }
  if (values.token) {
    const { formatted, symbol } = await readTokenBalance(
      sdk,
      values.token,
      chainId,
      config.address,
    )
    result.token = { address: values.token, symbol, balance: formatted }
  }
  if (config.json) {
    out(result)
  } else {
    print(`${result.native.symbol}: ${result.native.balance}`)
    if (result.token)
      print(
        `${result.token.symbol} (${result.token.address}): ${result.token.balance}`,
      )
  }
}
