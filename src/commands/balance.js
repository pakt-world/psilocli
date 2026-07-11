import { parseArgs } from 'node:util'
import { ethers } from 'ethers'
import { RPC_URLS, NATIVE_SYMBOLS, readTokenBalance } from '../chains.js'
import { out, fail } from '../output.js'

export async function cmdBalance(config, _auth, args) {
  const { values: flags } = parseArgs({
    args,
    options: {
      chain: { type: 'string' },
      token: { type: 'string' },
    },
    strict: true,
  })

  const chainId = flags.chain ?? '43113'
  const rpcUrl = RPC_URLS[chainId]
  if (!rpcUrl) fail(`No RPC URL configured for chain ${chainId}`)

  const provider = new ethers.JsonRpcProvider(rpcUrl)
  const raw = await provider.getBalance(config.address)
  const result = {
    native: {
      chain: chainId,
      symbol: NATIVE_SYMBOLS[chainId] ?? 'native',
      balance: ethers.formatEther(raw),
    },
  }

  if (flags.token) {
    const { formatted, symbol } = await readTokenBalance(
      flags.token,
      chainId,
      config.address,
    )
    result.token = { address: flags.token, symbol, balance: formatted }
  }

  if (config.json) {
    out(result)
  } else {
    process.stdout.write(`${result.native.symbol}: ${result.native.balance}\n`)
    if (result.token) {
      process.stdout.write(
        `${result.token.symbol} (${result.token.address}): ${result.token.balance}\n`,
      )
    }
  }
}
