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

const DEFAULT_RPC_TIMEOUT_MS = 15_000

export function rpcTimeoutMs() {
  const n = Number(process.env.PSILOCLI_RPC_TIMEOUT_MS)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RPC_TIMEOUT_MS
}

// A provider pinned to a known chain. Without a static network ethers probes eth_chainId first
// and, when the RPC is down, retries that probe forever ("failed to detect network") instead of
// rejecting, so no caller's .catch ever runs.
export function makeProvider(url, chainId) {
  const network = chainId != null && chainId !== '' ? Number(chainId) : undefined
  return network
    ? new ethers.JsonRpcProvider(url, network, { staticNetwork: true })
    : new ethers.JsonRpcProvider(url)
}

// Rejects with "RPC <url> unreachable" when `promise` has not settled within the RPC timeout
// (PSILOCLI_RPC_TIMEOUT_MS, default 15 s). Wrap the first read made through a provider in it.
export function withRpcTimeout(promise, url, ms = rpcTimeoutMs()) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`RPC ${url} unreachable (no answer within ${ms} ms; set PSILOCLI_RPC_TIMEOUT_MS or pass --rpc <url>)`)),
      ms,
    )
  })
  return Promise.race([
    Promise.resolve(promise).catch((err) => {
      throw new Error(`RPC ${url} unreachable: ${err?.shortMessage ?? err?.message ?? err}`)
    }),
    timeout,
  ]).finally(() => clearTimeout(timer))
}

// A provider whose RPC answered once (getBlockNumber) within the timeout.
export async function connectProvider(url, chainId) {
  const provider = makeProvider(url, chainId)
  try {
    await withRpcTimeout(provider.getBlockNumber(), url)
  } catch (err) {
    provider.destroy()
    throw err
  }
  return provider
}

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
  const provider = await connectProvider(rpcUrl, txPayload.chainId)
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

const RELEASE_ABI = [
  'function released() view returns (bool)',
  'event Released(address indexed recipient, uint256 payout, uint256 fee, uint256 nonce)',
]

// Whether the escrow has paid out, read on chain. The API's record lags it when a release landed
// but its confirmTx never ran (a killed process). `txHash` comes from the escrow's Released event
// in the last `lookback` blocks (public RPCs cap log ranges near 10k); null when it is older.
export async function escrowRelease(sdk, escrowAddress, chainId, rpcOverride = null, lookback = 9_000) {
  const url = rpcOverride ?? (await resolveRpcUrl(sdk, chainId))
  const provider = makeProvider(url, chainId)
  const escrow = new ethers.Contract(escrowAddress, RELEASE_ABI, provider)
  let released
  try {
    released = await withRpcTimeout(escrow.released(), url)
  } catch (err) {
    provider.destroy()
    throw err
  }
  if (!released) return { released: false, txHash: null }
  const latest = await provider.getBlockNumber()
  const logs = await escrow
    .queryFilter(escrow.filters.Released(), Math.max(0, latest - lookback), latest)
    .catch(() => [])
  return { released: true, txHash: logs.at(-1)?.transactionHash ?? null }
}

const READY_ABI = [
  'function readyForRelease() view returns (bool)',
  'event ReadyForRelease(address indexed seller)',
]

// Whether the seller already marked the escrow ready, read on chain (same shape as escrowRelease).
// `txHash` is the escrow's latest ReadyForRelease event in the last `lookback` blocks, or null.
export async function escrowReady(sdk, escrowAddress, chainId, rpcOverride = null, lookback = 9_000) {
  const url = rpcOverride ?? (await resolveRpcUrl(sdk, chainId))
  const provider = makeProvider(url, chainId)
  const escrow = new ethers.Contract(escrowAddress, READY_ABI, provider)
  let ready
  try {
    ready = await withRpcTimeout(escrow.readyForRelease(), url)
  } catch (err) {
    provider.destroy()
    throw err
  }
  if (!ready) return { ready: false, txHash: null }
  const latest = await provider.getBlockNumber()
  const logs = await escrow
    .queryFilter(escrow.filters.ReadyForRelease(), Math.max(0, latest - lookback), latest)
    .catch(() => [])
  return { ready: true, txHash: logs.at(-1)?.transactionHash ?? null }
}

// Reads ERC-20 balance, symbol and decimals directly from the token contract.
export async function readTokenBalance(sdk, contractAddress, chainId, address) {
  const rpcUrl = await resolveRpcUrl(sdk, chainId)
  const provider = makeProvider(rpcUrl, chainId)
  const erc20 = new ethers.Contract(
    contractAddress,
    [
      'function balanceOf(address) view returns (uint256)',
      'function symbol() view returns (string)',
      'function decimals() view returns (uint8)',
    ],
    provider,
  )
  const [balance, symbol, decimals] = await withRpcTimeout(
    Promise.all([erc20.balanceOf(address), erc20.symbol(), erc20.decimals()]),
    rpcUrl,
  )
  return { formatted: ethers.formatUnits(balance, Number(decimals)), symbol }
}
