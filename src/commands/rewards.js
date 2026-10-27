import { ethers } from 'ethers'
import { parseCommand, resolveConfig } from '../config.js'
import { cliInit } from '../client.js'
import { resolveRpc, fetchAvailableChains } from '../chains.js'
import { out, print, note, fail } from '../output.js'

export const usage = `psilocli rewards [--chain <id>]
psilocli rewards claim [--chain <id>]`

// $PAKT rebates and juror rewards are pushed by the purchaser in batches; one that could not be
// pushed waits in PaktPurchaser.claimable(you). The purchaser is found from the chain's escrow
// factory: factory.feeVault() → vault.purchaser() → purchaser.pakt().
const ABI = [
  'function feeVault() view returns (address)',
  'function purchaser() view returns (address)',
  'function pakt() view returns (address)',
  'function claimable(address) view returns (uint256)',
  'function claim()',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
]

async function locate(sdk, chainId) {
  const rpc = await resolveRpc(sdk, chainId)
  const chain = (await fetchAvailableChains(sdk)).find((c) => String(c.chainId) === rpc.chainId)
  if (!chain?.factoryAddress) throw new Error(`Chain ${rpc.chainId} has no escrow factory configured.`)
  const provider = new ethers.JsonRpcProvider(rpc.url)
  const at = (address) => new ethers.Contract(address, ABI, provider)
  const vault = await at(chain.factoryAddress).feeVault()
  if (vault === ethers.ZeroAddress) throw new Error(`The escrow factory on chain ${rpc.chainId} has no fee vault.`)
  const purchaser = await at(vault).purchaser()
  if (purchaser === ethers.ZeroAddress) throw new Error(`The fee vault on chain ${rpc.chainId} has no $PAKT purchaser yet.`)
  const token = at(await at(purchaser).pakt())
  const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()])
  return { rpc, provider, purchaser, symbol, decimals: Number(decimals) }
}

export async function run(argv) {
  const sub = argv[0] === 'claim' ? 'claim' : null
  const { values } = parseCommand(sub ? argv.slice(1) : argv, { chain: { type: 'string' } })
  const config = resolveConfig(values)
  const { sdk } = await cliInit(config)
  const loc = await locate(sdk, values.chain)
  const read = new ethers.Contract(loc.purchaser, ABI, loc.provider)
  const owed = await read.claimable(config.address)
  const amount = ethers.formatUnits(owed, loc.decimals)

  if (!sub) {
    if (config.json) return out({ chainId: loc.rpc.chainId, purchaser: loc.purchaser, claimable: owed.toString(), amount, symbol: loc.symbol })
    print(`Claimable: ${amount} ${loc.symbol} on ${loc.rpc.name} (purchaser ${loc.purchaser})`)
    if (owed === 0n) note('Rebates and juror rewards are normally pushed to your wallet; only a failed push lands here.')
    return
  }

  if (owed === 0n) fail(`Nothing to claim on ${loc.rpc.name}.`)
  const wallet = new ethers.Wallet(config.key, loc.provider)
  note(`Claiming ${amount} ${loc.symbol}...`)
  const tx = await new ethers.Contract(loc.purchaser, ABI, wallet).claim()
  const receipt = await tx.wait()
  if (config.json) return out({ ok: true, txHash: receipt.hash, amount, symbol: loc.symbol })
  print(`Claimed ${amount} ${loc.symbol} — txHash: ${receipt.hash}`)
}
