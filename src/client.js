import { PsiloSDK } from '@pakt/psilo'

export function sdkOk(result, label) {
  if (!result || result.status === 'error' || !result.data) {
    throw new Error(
      `${label} failed: ${JSON.stringify(result?.message ?? result)}`,
    )
  }
  return result.data
}

export function decodeUserId(token) {
  const payload = JSON.parse(
    Buffer.from(token.split('.')[1], 'base64url').toString(),
  )
  return payload.id ?? payload.sub
}

export async function cliInit(config) {
  const sdk = await PsiloSDK.init({ baseUrl: config.url })
  const jwt = await sdk.auth.paktWeb3Login(config.key)
  const userId = decodeUserId(jwt)
  sdk.setAuthorizationHeader(jwt)
  return { sdk, userId, jwt }
}

export async function resolveUserIdByAddress(config, address) {
  const res = await fetch(
    `${config.url}/v1/account-public/by-wallet/${encodeURIComponent(address)}`,
  )
  if (!res.ok) throw new Error(`by-wallet lookup failed: ${res.status}`)
  const body = await res.json()
  const userId = body?.data?._id ?? body?._id
  if (!userId) throw new Error(`No user found for address ${address}`)
  return String(userId)
}
