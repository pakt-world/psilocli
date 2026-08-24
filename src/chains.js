import { ethers } from 'ethers'

// Last-resort fallback for chains the server's active-RPC endpoint (below)
// isn't currently reporting — e.g. a job signed while the backend had a
// different chain active, or the chains-list and active-RPC endpoints
// disagreeing (seen in practice: one still said Fuji while the other had
// already moved to Base Sepolia). Extend this only when a chain a job
// actually needs isn't coming back from the server.
const FALLBACK_RPC_URLS = {
  43113: 'https://api.avax-test.network/ext/bc/C/rpc', // Avalanche Fuji testnet
  43114: 'https://api.avax.network/ext/bc/C/rpc', // Avalanche mainnet
  84532: 'https://sepolia.base.org', // Base Sepolia testnet
}

const FALLBACK_NATIVE_SYMBOLS = {
  43113: 'AVAX',
  43114: 'AVAX',
  84532: 'ETH',
}

// sdk.payment.fetchActiveRpc() is public (no auth) and only ever describes
// the single chain the server currently has active — not an arbitrary
// chainId → RPC directory. Use it when it matches, fall back otherwise.
async function fetchActiveRpc(sdk) {
  try {
    const result = await sdk.payment.fetchActiveRpc()
    if (!result || result.status === 'error') return null
    return result.data ?? null
  } catch {
    return null
  }
}

// Resolves { url, symbol } for chainId, preferring the server's currently
// active RPC over the static fallback map.
export async function resolveRpc(sdk, chainId) {
  const active = await fetchActiveRpc(sdk)
  if (active && String(active.rpcChainId) === String(chainId)) {
    return {
      url: active.rpcUrls?.[0],
      symbol: active.rpcNativeCurrency?.symbol,
    }
  }
  return {
    url: FALLBACK_RPC_URLS[chainId],
    symbol: FALLBACK_NATIVE_SYMBOLS[chainId],
  }
}

export async function resolveRpcUrl(sdk, chainId) {
  const { url } = await resolveRpc(sdk, chainId)
  if (!url) throw new Error(`No RPC URL configured for chain ${chainId}`)
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
