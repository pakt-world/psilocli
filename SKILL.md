# psilocli Skill

## What this is

`@pakt/psilocli` is a terminal client for the Pakt marketplace. Every command
is a one-shot invocation: authenticate with the agent wallet, call the
Paktsuite API through the Psilo SDK, sign any returned transaction payloads
locally, print the result, exit. There is no daemon, no LLM, no background
state.

```
┌────────────────────────────────────────────────────────┐
│  bin/psilocli.mjs → src/commands/*                     │
│                                                        │
│  PsiloSDK (REST)   ←→  Paktsuite API                   │
│  MessagingService  ←→  Paktsuite WS (messages … only)  │
│  ethers.js         ←→  EVM chain (Avalanche)           │
└────────────────────────────────────────────────────────┘
```

## SDK — @pakt/psilo

**Always use the Psilo SDK. Never call Paktsuite endpoints directly.**
Known exception: `resolveUserIdByAddress()` in `src/commands/create-job.js`
uses `GET /v1/account-public/by-wallet/<address>` because the SDK has no
method for it yet — move it into the SDK when one exists.

Auth flow (`src/client.js` → `cliInit()`):

```js
const sdk = await PsiloSDK.init({ baseUrl: config.url })
const jwt = await sdk.auth.paktWeb3Login(config.key)   // signs a challenge
sdk.setAuthorizationHeader(jwt)
const userId = decodeUserId(jwt)                        // JWT payload id/sub
```

### `sdkOk()` helper

Every SDK call returns a `ResponseDto` envelope. Unwrap it with
`sdkOk(result, label)` (`src/client.js`) — it throws
`"<label> failed: <message>"` when `status === 'error'` or `data` is missing.

## Job lifecycle and SDK calls

```
Buyer                                Seller
─────────────────────────────────────────────────────
create-job:
  job.create → job.makeDeposit
  sign approve? + deposit txs
  job.validatePayment (6×10s retry)
  job.inviteTalent (+ sign onInvite → job.confirmTx)
                         list invites (job.listAllInvites)
                         accept-invite:
                           job.acceptInvite
                           sign acceptPayload → confirmTx onAccept
                         complete-job:
                           job.getById → toggleDeliverableProgress each
                           job.completeJob
                           sign markReadyPayload → confirmTx onMarkReady (6×10s)
release-payment:
  job.releasePayment
  sign releasePayload → confirmTx onRelease
review: job.submitReview
```

## Chain / transaction signing

`src/chains.js` → `signAndBroadcast(key, txPayload)`:

- Picks the RPC from `RPC_URLS[txPayload.chainId]` (43113 Fuji, 43114
  Avalanche mainnet) — extend `RPC_URLS`/`NATIVE_SYMBOLS` for new chains.
- Signs with `ethers.Wallet`, sends, and **waits one confirmation**
  (`tx.wait()`), so callers never need blind sleeps after it returns.
- API tx payloads are unsigned `{ to, data, value, gas, maxFeePerGas,
  maxPriorityFeePerGas, chainId }` objects; the pattern is always
  `signAndBroadcast(...)` then `job.confirmTx(jobId, { step, txHash })`
  with step `onInvite | onAccept | onMarkReady | onRelease`.

## Messaging

`src/messaging.js` → `withMessaging(config, jwt, fn)` opens a socket,
runs `fn`, disconnects in `finally`. Socket emits (`sendMessage`,
`markSeen`) are fire-and-forget — `messages send` waits for the broadcast
echo of its own message with a `FLUSH_MS` (1.5s) fallback before
disconnecting. Request/response socket calls (`loadConversations`,
`fetchConversation`, `createDirectConversation`, `createGroupConversation`)
are wrapped in `withTimeout(promise, 10_000, label)`.

`messages watch` is the only command that stays connected: it prints
`onBroadcast` events until SIGINT. Keep it that way — no reconnect loops,
no handlers with side effects.

## Configuration

| Flag            | Env var             | Default                         |
| --------------- | ------------------- | ------------------------------- |
| `-n, --name`    | `AGENT_NAME`        | `agent`                         |
| `-k, --key`     | `AGENT_PRIVATE_KEY` | required                        |
| `-a, --address` | `AGENT_ADDRESS`     | required                        |
| `-u, --url`     | `PAKTSUITE_URL`     | `https://devapi-psilo.kapt.xyz` |
| `--json`        | —                   | off                             |

`create-job` also honors `INVITE_AGENT_ADDRESS`, `JOB_TITLE`,
`JOB_DESCRIPTION`, `JOB_AMOUNT`, `JOB_CHAIN_ID`, `JOB_ASSET`,
`JOB_DELIVERABLE` as flag fallbacks.

## Output discipline

- stdout: command output only — human tables via `cliTable()` or `--json`
  via `out()`. `messages watch --json` emits NDJSON.
- stderr: progress/diagnostics via `note()`, errors via `fail(msg, code)`.
- Exit codes: 0 success, 1 error, 2 usage error (strict parseArgs makes
  unknown flags a usage error).

## Common errors and fixes

### `--key / AGENT_PRIVATE_KEY is required`

Export `AGENT_PRIVATE_KEY` and `AGENT_ADDRESS`, or pass `-k`/`-a`.

### `No RPC URL configured for chain <id>`

The tx payload's `chainId` is missing or the chain isn't in
`src/chains.js` → `RPC_URLS`. Add the chain or pass `--chain-id`.

### `validatePayment attempt n/6 failed`

Deposit not yet indexed by the API. The loop retries every 10s; if all 6
fail, check the deposit tx hash on the explorer and re-run
`psilocli create-job` — or fund the wallet if the deposit never went out.

### `No releasePayload returned — job may not be in review status`

`release-payment` only works after the seller's `complete-job` confirmed
`onMarkReady`. Check `psilocli list jobs --role buyer --status ongoing`.

### `createDirectConversation timed out after 10s`

Socket connected but the server didn't answer — usually a bad recipient
userId. Verify with `psilocli whoami` on the other agent.

## Adding a command

1. Create `src/commands/<verb>.js` exporting `usage` and `run(argv)`.
2. Parse flags with `parseCommand(argv, options, { positionals })`,
   resolve auth with `resolveConfig(values)`, init with `cliInit(config)`.
3. Register it in `COMMANDS` and the help text in `bin/psilocli.mjs`.
4. Support `--json` (via `config.json`) and keep stdout/stderr discipline.
