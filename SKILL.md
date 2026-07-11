# psilocli Skill

## What this is

`psilocli` is a terminal client for the Pakt marketplace. It wraps the Psilo SDK
and handles wallet signing via ethers.js for the escrow flow.

---

## SDK — @pakt/psilo

**Always use the Psilo SDK. Never call Paktsuite endpoints directly.**
Base URL: `https://devapi-psilo.kapt.xyz/`

Source: `/Users/jendorski/Documents/Pakt/PsiloSDK/`

After editing SDK source, rebuild AND copy both dist files:

```sh
cd /Users/jendorski/Documents/Pakt/PsiloSDK
npm run build
cp dist/main.js     /Users/jendorski/Documents/Pakt/psilocli/node_modules/@pakt/psilo/dist/main.js
cp dist/main.js.map /Users/jendorski/Documents/Pakt/psilocli/node_modules/@pakt/psilo/dist/main.js.map
cp dist/main.mjs     /Users/jendorski/Documents/Pakt/psilocli/node_modules/@pakt/psilo/dist/main.mjs
cp dist/main.mjs.map /Users/jendorski/Documents/Pakt/psilocli/node_modules/@pakt/psilo/dist/main.mjs.map
```

Node ESM resolves `.mjs` — failing to copy it means old SDK code runs silently.

### SDK calls used by psilocli

| Call | What it does |
|---|---|
| `sdk.auth.paktWeb3Login(privateKey)` | Signs a challenge, returns JWT |
| `sdk.job.list({ status, role, limit })` | Fetch jobs by status/role |
| `sdk.job.getById(jobId)` | Full job document |
| `sdk.job.apply(jobId, { coverLetter })` | Submit application as seller |
| `sdk.job.listAllInvites()` | Pending invites for this agent |
| `sdk.job.acceptInvite(jobId, inviteId)` | Accept invite, returns `acceptPayload` tx |
| `sdk.job.declineInvite(jobId, inviteId)` | Decline invite |
| `sdk.job.inviteTalent(jobId, { inviteeId })` | Invite a specific user |
| `sdk.job.create(dto)` | Create job record |
| `sdk.job.makeDeposit(jobId)` | Prepare escrow — returns `approve` + `deposit` txs |
| `sdk.job.validatePayment(jobId)` | Confirm deposit on-chain |
| `sdk.job.toggleDeliverableProgress(jobId, deliverableId, { status })` | Mark deliverable complete |
| `sdk.job.completeJob(jobId, {})` | Mark all deliverables done, returns `markReadyPayload` tx |
| `sdk.job.confirmTx(jobId, { step, txHash, inviteeId? })` | Confirm on-chain tx |
| `sdk.job.releasePayment(jobId)` | Buyer releases escrow, returns `releasePayload` tx |
| `sdk.job.submitReview(jobId, { receiverId, review, rating })` | Submit 1–5 star review |

### `sdkOk()` helper (src/client.js)

```js
function sdkOk(result, label) {
  if (!result || result.status === 'error' || !result.data) {
    throw new Error(`${label} failed: ${JSON.stringify(result?.message ?? result)}`)
  }
  return result.data
}
```

All SDK calls are wrapped in `sdkOk()`. An error response throws immediately.

---

## TX signing pattern (src/chains.js)

`signAndBroadcast(txPayload, agentKey)` looks up the RPC URL by `chainId`,
signs, broadcasts, and waits for one block confirmation via `tx.wait()`.
**No sleep needed after broadcasting** — `tx.wait()` handles it.

Server tx objects often omit `chainId` — inject it from the parent response:

```js
// makeDeposit pattern
const approveTx = { ...depositData.approve, chainId: depositData.approve.chainId ?? depositData.chainId }
const depositTx = { ...depositData.deposit, chainId: depositData.deposit.chainId ?? depositData.chainId }

// releasePayment pattern
const releaseTx = { ...releasePayload, chainId: releasePayload.chainId ?? fallbackChainId }
```

### `confirmTx` steps

| Step | When |
|---|---|
| `onInvite` | After signing `invitePayload` (buyer → create-job) |
| `onAccept` | After signing `acceptPayload` (seller → accept-invite) |
| `onMarkReady` | After signing `markReadyPayload` (seller → complete-job); 6-attempt retry, 10s apart |
| `onRelease` | After signing `releasePayload` (buyer → release-payment) |

---

## Configuration

All options as CLI flags or env vars. Flags take precedence.

| Flag | Env var | Default | Required |
|---|---|---|---|
| `--name` | `AGENT_NAME` | `agent` | |
| `--key` | `AGENT_PRIVATE_KEY` | | ✅ (use env var) |
| `--address` | `AGENT_ADDRESS` | | ✅ |
| `--url` | `PAKTSUITE_URL` | `https://devapi-psilo.kapt.xyz` | |
| `--json` | | `false` | |

---

## Supported chains

| Chain ID | Network | Native |
|---|---|---|
| 43113 | Avalanche Fuji testnet | AVAX |
| 43114 | Avalanche mainnet | AVAX |

ERC-20 for Fuji testing: `0x5425890298aed601595a70AB815c96711a31Bc65` (USDC)

---

## Common errors and fixes

### `AGENT_PRIVATE_KEY is required`

Env var not set. Export it before running any command.

### `No RPC URL configured for chain undefined`

`chainId` missing from the tx payload. Inject from the parent response — see tx-signing pattern above.

### `messaging.onPaymentReleased is not a function`

Node ESM is loading old `dist/main.mjs`. Rebuild SDK and copy both `.js` and `.mjs` files.

### `Messaging connect timed out after 10s`

API unreachable or token expired. Check `PAKTSUITE_URL` and re-run (a new `cliInit()` will re-authenticate).

### `currency: Path 'currency' is required`

Job created without ERC-20 asset — `coinData` is null. Server-side fix: use the fallback chain in job.service.ts. Client-side: pass `--asset <contract>` or leave it out for native.

### `BSONTypeError: new Types.ObjectId("undefined")`

SDK `parseUrlWithQuery` received a literal `"undefined"` string. Rebuild SDK from `PsiloSDK/src/utils/response.ts`.
