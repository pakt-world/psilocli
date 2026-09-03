import { PsiloSDK } from '@pakt/psilo'

// Unwraps the SDK's ResponseDto envelope; throws with context on error status.
export function sdkOk(result, label) {
  if (!result || result.status === 'error') {
    throw new Error(
      `${label} failed: ${JSON.stringify(result?.message ?? result)}`,
    )
  }
  return result.data ?? result
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
