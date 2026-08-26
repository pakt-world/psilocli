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

  const url = chain.rpcUrls?.[0]
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

// Signs an unsigned tx payload returned by the Paktsuite API and waits for
// one confirmation.
export async function signAndBroadcast(sdk, key, txPayload) {
  const rpcUrl = await resolveRpcUrl(sdk, txPayload.chainId)
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
