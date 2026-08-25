import { ethers } from 'ethers'

// sdk.payment.fetchActiveRpc() is public (no auth) and only ever describes
// the single chain the server currently has active — not an arbitrary
// chainId → RPC directory.
//
// There is no hardcoded fallback RPC. If the server has no active RPC
// configured, or its active RPC doesn't match the chain a command needs,
// callers must stop and ask the user to pass --chain explicitly rather than
// silently operating against a guessed or stale network.
export async function fetchActiveRpc(sdk) {
  try {
    const result = await sdk.payment.fetchActiveRpc()
    if (!result || result.status === 'error') return null
    return result.data ?? null
  } catch {
    return null
  }
}

// Resolves { url, symbol } for chainId strictly from the server's active RPC.
// Throws (never falls back) if no active RPC is configured, or if it doesn't
// match the requested chainId.
export async function resolveRpc(sdk, chainId) {
  const active = await fetchActiveRpc(sdk)
  if (!active) {
    throw new Error(
      'No active RPC is configured on the server. Pass --chain explicitly, or have the server configure an active RPC, before proceeding.',
    )
  }
  if (chainId && String(active.rpcChainId) !== String(chainId)) {
    throw new Error(
      `No RPC is available for chain ${chainId} — the server's active chain is ${active.rpcChainId}. Pass --chain ${active.rpcChainId}, or omit --chain to use the active chain.`,
    )
  }
  if (!active.rpcUrls?.[0]) {
    throw new Error(
      `The server's active chain (${active.rpcChainId}) has no RPC URL configured. Cannot proceed.`,
    )
  }
  return {
    url: active.rpcUrls[0],
    symbol: active.rpcNativeCurrency?.symbol,
    chainId: String(active.rpcChainId),
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
