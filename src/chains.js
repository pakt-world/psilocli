import { ethers } from 'ethers'

export const RPC_URLS = {
  43113: 'https://api.avax-test.network/ext/bc/C/rpc',
  43114: 'https://api.avax.network/ext/bc/C/rpc',
}

export const NATIVE_SYMBOLS = {
  43113: 'AVAX',
  43114: 'AVAX',
}

export async function signAndBroadcast(txPayload, agentKey) {
  const rpcUrl = RPC_URLS[txPayload.chainId]
  if (!rpcUrl)
    throw new Error(`No RPC URL configured for chain ${txPayload.chainId}`)
  const provider = new ethers.JsonRpcProvider(rpcUrl)
  const wallet = new ethers.Wallet(agentKey, provider)
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

export async function readTokenBalance(contractAddress, chainId, address) {
  const rpcUrl = RPC_URLS[chainId] ?? Object.values(RPC_URLS)[0]
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
