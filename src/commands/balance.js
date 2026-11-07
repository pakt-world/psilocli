import { ethers } from 'ethers'
import { parseCommand, resolveConfig } from '../config.js'
import { cliInit } from '../client.js'
import { resolveRpc, readTokenBalance, makeProvider, withRpcTimeout } from '../chains.js'
import { out, print, note } from '../output.js'

export const usage = 'psilocli balance [--chain <id>] [--token <0x>]'

export async function run(argv) {
  const { values } = parseCommand(argv, {
    chain: { type: 'string' },
    token: { type: 'string' },
  })
  const config = resolveConfig(values)
  const { sdk } = await cliInit(config)
  const chainId = values.chain ?? null
  const { url: rpcUrl, symbol: nativeSymbol, chainId: resolvedChainId, name: chainName } =
    await resolveRpc(sdk, chainId)
  if (!chainId) note(`Default chain: ${chainName} (chainId ${resolvedChainId})`)
  const provider = makeProvider(rpcUrl, resolvedChainId)
  const raw = await withRpcTimeout(provider.getBalance(config.address), rpcUrl)
  const result = {
    native: {
      chain: resolvedChainId,
      symbol: nativeSymbol ?? 'native',
      balance: ethers.formatEther(raw),
    },
  }
  if (values.token) {
    const { formatted, symbol } = await readTokenBalance(
      sdk,
      values.token,
      resolvedChainId,
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
