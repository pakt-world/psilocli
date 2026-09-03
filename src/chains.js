import { ethers } from 'ethers'

// Fetches all chains on which new escrows can be created.
export async function fetchAvailableChains(sdk) {
  try {
    const result = await sdk.payment.fetchAvailableChains()
    if (!result || result.status === 'error') return []
    return result.data ?? []
  } catch {
    return []
  }
}

// Resolves { url, symbol, chainId } for a given chainId from the server's
// list of available chains. Falls back to the active RPC when no chainId is
// specified (picks the default chain). Throws if the chain isn't found.
export async function resolveRpc(sdk, chainId) {
  const chains = await fetchAvailableChains(sdk)

  let chain
  if (chainId) {
    chain = chains.find(c => String(c.chainId) === String(chainId))
    if (!chain) {
      const ids = chains.map(c => c.chainId).join(', ') || 'none'
      throw new Error(
        `Chain ${chainId} is not available on this server. Available chains: ${ids}.`,
      )
    }
  } else {
    chain = chains.find(c => c.isDefault) ?? chains[0]
    if (!chain) {
      throw new Error(
        'No chains are configured on this server. Cannot proceed.',
      )
    }
  }

  const url = chain.publicRpcUrls?.[0]
  if (!url) {
    throw new Error(
      `Chain ${chain.chainId} (${chain.name ?? 'unknown'}) has no RPC URL configured on the server.`,
    )
  }

  return {
    url,
    name: chain.name ?? String(chain.chainId),
    symbol: chain.nativeCurrency?.symbol,
    chainId: String(chain.chainId),
    rpcServerId: chain.rpcServerId,
    isDefault: chain.isDefault,
  }
}

export async function resolveRpcUrl(sdk, chainId) {
  const { url } = await resolveRpc(sdk, chainId)
  return url
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

// Signs an unsigned tx payload returned by the Paktsuite API and waits for
// one confirmation.
export async function signAndBroadcast(sdk, key, txPayload, rpcOverride = null) {
  if (!txPayload.to || txPayload.to.toLowerCase() === ZERO_ADDRESS) {
    throw new Error(
      `Refusing to sign transaction with no destination address (to: ${txPayload.to ?? '(missing)'}) — ` +
      'the server returned a malformed payload. Do not retry blindly; this would burn gas with no effect.',
    )
  }
  const rpcUrl = rpcOverride ?? await resolveRpcUrl(sdk, txPayload.chainId)
  const provider = new ethers.JsonRpcProvider(rpcUrl)
  const wallet = new ethers.Wallet(key, provider)
  const tx = await wallet.sendTransaction({
    to: txPayload.to,
    data: txPayload.data,
    value: txPayload.value,
    gasLimit: txPayload.gas,
    maxFeePerGas: txPayload.maxFeePerGas,
    maxPriorityFeePerGas: txPayload.maxPriorityFeePerGas,
  })
  const receipt = await tx.wait()
  return receipt.hash
}

// Resolves a job's display symbol from its on-chain asset address, since
// `job.currency` is frequently null even when `asset` is populated. Matches
// asset against each active coin's per-chain contract address first, then
// falls back to matching the address against any chain (some job records
// carry a contract address registered under a different chainId). An empty
// asset means the job is funded in the chain's native token.
export function resolveAssetSymbol(coins, chains, { asset, chainId }) {
  const addr = (asset ?? '').toLowerCase()
  if (!addr) {
    const chain = chains.find(c => String(c.chainId) === String(chainId))
    return chain?.nativeCurrency?.symbol ?? '?'
  }
  const exact = coins.find(
    c => (c.contractAddresses?.[String(chainId)] ?? '').toLowerCase() === addr,
  )
  if (exact) return exact.symbol
  const loose = coins.find(c =>
    Object.values(c.contractAddresses ?? {}).some(a => a.toLowerCase() === addr),
  )
  if (loose) return loose.symbol
  return `${asset.slice(0, 6)}…${asset.slice(-4)}`
}

// Reads ERC-20 balance, symbol and decimals directly from the token contract.
export async function readTokenBalance(sdk, contractAddress, chainId, address) {
  const rpcUrl = await resolveRpcUrl(sdk, chainId)
  const provider = new ethers.JsonRpcProvider(rpcUrl)
  const erc20 = new ethers.Contract(
    contractAddress,
    [
      'function balanceOf(address) view returns (uint256)',
      'function symbol() view returns (string)',
      'function decimals() view returns (uint8)',
    ],
    provider,
  )
  const [balance, symbol, decimals] = await Promise.all([
    erc20.balanceOf(address),
    erc20.symbol(),
    erc20.decimals(),
  ])
  return { formatted: ethers.formatUnits(balance, Number(decimals)), symbol }
}
