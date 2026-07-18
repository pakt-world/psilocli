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
runs `fn`, disconnects in `finally`.

Chat request/response goes through `wsRequest(messaging, event, payload)`,
which uses socket.io acknowledgements (`emitWithAck`, 10s timeout) and
unwraps the `{ error, statusCode, message, data }` envelope. This is a
deliberate workaround: paktsuite replies to chat events via acks, but the
SDK's request/response methods (`loadConversations`,
`createDirectConversation`, `fetchConversation`, ...) emit without an ack
and wait for a same-named event the server never sends — they always time
out. When the SDK adopts acks, switch back and delete `wsRequest`.

`messages watch` is the only command that stays connected: it prints
`onBroadcast` events until SIGINT. Keep it that way — no reconnect loops,
no handlers with side effects.

## Auth commands (`sdk.auth`)

`auth` commands do **not** use `cliInit()`. They instantiate a bare,
unauthenticated SDK instance directly (`PsiloSDK.init({ baseUrl })`), because
these commands *are* the authentication flow.

| Sub-verb   | SDK calls                                          | Required flags                      |
| ---------- | -------------------------------------------------- | ------------------------------------ |
| `register` | request → sign → validate → onboard? → re-auth    | `--key`, `--address`                 |
| `request`  | `web3AuthRequest(address)`                         | `--address`                          |
| `validate` | `web3AuthValidate(signed, tempToken, tokenId?)`    | `--signed-message`, `--temp-token`   |
| `onboard`  | `web3AuthOnboard(tempToken, first, last, email)`   | `--temp-token`, `--email`            |

`auth register` handles both paths: existing wallet (returns JWT immediately)
and first-login onboard (full flow with user-supplied name/email). `--email`
defaults to `address@pakt.internal` with a stderr warning when omitted.

## Upload service (`sdk.upload`)

```
upload <path> [--private] [--type <mime>]   Upload a file (public or private)
upload list [--page <n>] [--limit <n>] [--name <s>]  List uploaded files
upload get <id>                             Fetch a single FileRecord
upload url <id>                             Get a presigned download URL
```

Allowed MIME types are enforced client-side before the request is sent (see
`ALLOWED_MIME_TYPES` in `src/commands/upload.js`). Extension → MIME detection
covers common formats; `--type` overrides it. An unknown extension with no
`--type` is a usage error (exit 2).

`--profile-image` and `--bg-image` on `user update` take the `_id` of an
uploaded `FileRecord` — upload first, then pass the returned ID.

## User service (`sdk.user`)

```
user update [--first-name <s>] [--last-name <s>] [--username <s>]
            [--profile-image <upload-id>] [--bg-image <upload-id>] [--private]
```

Only explicitly-supplied flags are included in the PATCH payload — absent
flags are never sent so the API treats them as no-ops.

## Configuration

| Flag            | Env var             | Default                         |
| --------------- | ------------------- | ------------------------------- |
| `-n, --name`    | `AGENT_NAME`        | `agent`                         |
| `-k, --key`     | `AGENT_PRIVATE_KEY` | required                        |
| `-a, --address` | `AGENT_ADDRESS`     | required                        |
| `-u, --url`     | `PAKTSUITE_URL`     | `https://devapi-psilo.kapt.xyz` |
| `--json`        | —                   | off                             |

`create-job` requires `--title` and honors `INVITE_AGENT_ADDRESS`,
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

### `INITIALIZE_CONVERSATION timed out after 10s`

Known deployed-server bug (as of July 2026, devapi): the
`INITIALIZE_CONVERSATION` handler never sends its acknowledgement — other
chat events (`GET_ALL_CONVERSATIONS`, `FETCH_CONVERSATION_MESSAGES`,
`MARK_MESSAGE_AS_SEEN`) ack fine, and both paktsuite/paktsuite-v2 sources
do ack, so the deployed build predates that fix. Until it's redeployed,
`messages send --to` and group creation cannot open new conversations;
`messages send --conversation <id>` into an existing conversation works.

## Adding a command

1. Create `src/commands/<verb>.js` exporting `usage` and `run(argv)`.
2. Parse flags with `parseCommand(argv, options, { positionals })`,
   resolve auth with `resolveConfig(values)`, init with `cliInit(config)`.
3. Register it in `COMMANDS` and the help text in `bin/psilocli.mjs`.
4. Support `--json` (via `config.json`) and keep stdout/stderr discipline.
