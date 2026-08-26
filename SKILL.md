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

`sdk.job.getById(id)` returns `ResponseDto<JobResponse>` — the job is in
`data` directly. Older SDK versions wrapped it as `{ job: JobResponse }`;
command files use `sdkOk(result)?.job ?? sdkOk(result)` for backward
compatibility (the `?.job` branch is a no-op against the current SDK but
harmless to keep).

## Payment discovery (`sdk.payment`)

Before creating a job, query the server for available chains and coins:

```sh
psilocli list chains          # all chains where escrows can be created (isDefault marked)
psilocli list coins           # all active payment coins
psilocli list coins --chain-id 84532   # filter by chain (resolved server-side via rpcServerId)
```

Internally these call:

```
sdk.payment.fetchAvailableChains()          GET /v1/payment/chains  (public — no auth required)
sdk.payment.fetchActiveRpc()                GET /v1/payment/rpc     (public — no auth required)
sdk.payment.fetchPaymentCoins({ rpcId? })   GET /v1/payment/coins   (public — no auth required)
```

`fetchAvailableChains()` returns `AvailableChain[]`. Each record has:

| Field          | Meaning                                                      |
| -------------- | ------------------------------------------------------------ |
| `rpcServerId`  | ID of the backing RPC server record (pass as `rpcId` to `fetchPaymentCoins`) |
| `chainId`      | EVM chain ID (string)                                        |
| `name`         | Human-readable chain name                                    |
| `rpcUrls`      | RPC endpoints for signing transactions                       |
| `nativeCurrency` | `{ name, symbol, decimals }`                               |
| `isDefault`    | True for the chain used when no `chainId` is sent            |
| `factoryAddress` | Escrow factory contract address                            |

`resolveRpc(sdk, chainId?)` in `src/chains.js` now uses `fetchAvailableChains()` — it finds the chain by `chainId`, or picks `isDefault` when no `chainId` is given. This means signing works for any available chain, not just the server's currently-active one.

`fetchPaymentCoins()` returns `PaymentCoin[]`. Each record has:

| Field             | Meaning                                              |
| ----------------- | ---------------------------------------------------- |
| `_id`             | The ID the server expects in `CreateJobDto.currency` |
| `symbol`          | Human-readable ticker (e.g. `USDC`, `AVAX`)          |
| `contractAddress` | ERC-20 address; absent on native coins               |
| `isToken`         | `true` = ERC-20, `false` = native coin               |
| `rpcChainId`      | Chain this coin lives on                             |
| `active`          | Only active coins are usable                         |

### `--coin <symbol>` resolution in `create-job`

`--coin` (or `JOB_COIN` env var) is the preferred way to specify payment. It
auto-resolves three fields so you don't have to look them up manually:

1. Fetches all active coins, finds one whose `symbol` matches (case-insensitive).
2. Sets `asset = coin.contractAddress` for ERC-20 tokens, `''` for native coins.
3. Sets `currency = coin._id` — **the server stores the coin record's `_id`, not the symbol**.
4. Sets `chainId = String(coin.rpcChainId)` unless `--chain-id` overrides it.

If neither `--coin` nor `--chain-id` nor `JOB_CHAIN_ID` is set, `create-job`
calls `fetchActiveRpc()` to read the server's currently active chain.

## Job lifecycle and SDK calls

```
Buyer                                Seller
─────────────────────────────────────────────────────────────────────
Pre-flight (optional):
  list chains  → sdk.payment.fetchActiveRpc()
  list coins   → sdk.payment.fetchPaymentCoins()

create-job:
  sdk.payment.fetchPaymentCoins()       (when --coin is used)
  sdk.payment.fetchAvailableChains()    (chain resolution via resolveRpc — replaces fetchActiveRpc)
  user.getUserByWalletAddress()         (--invite: resolve address → userId, pre-flight)
  user.getUserById()                    (--invite-id: validate userId exists, pre-flight)
  job.create(dto)
  job.makeDeposit(jobId)
  sign ERC-20 approve tx           (ERC-20 tokens only)
  sign deposit tx
  job.validatePayment(jobId)       (retries 6×10s)
  job.inviteTalent(jobId)
  sign onInvite tx → job.confirmTx(jobId, { step:'onInvite' })

create-job --resume <jobId>:        (crash recovery)
  job.getById(jobId)               check status ≠ cancelled/completed
  job.getEscrowStatus(jobId)       → onChain.deposited?
    false → resume from makeDeposit + sign + validatePayment
    true  → skip deposit
  if status not ongoing/review/completed → inviteTalent (needs --invite)

cancel-job:
  job.getCancelRequest(jobId)      pre-flight: reject if already pending
  job.requestCancel(jobId, dto)

delete-job: job.delete(jobId)     hard delete — for unfunded/junk jobs, no
                                   counterparty acceptance needed

                         accept-cancel / decline-cancel:
                           job.acceptCancel(jobId, dto?)
                           job.declineCancel(jobId, dto?)

                         list invites → job.listAllInvites()
                         accept-invite:
                           job.acceptInvite(jobId, inviteId)
                           sign acceptPayload → confirmTx onAccept
                         complete-job:
                           job.getById → toggleDeliverableProgress each
                           job.completeJob(jobId)
                           sign markReadyPayload → confirmTx onMarkReady (6×10s)
release-payment:
  job.releasePayment(jobId)
  sign releasePayload → confirmTx onRelease
review: job.submitReview(jobId, dto)
reviews: job.getReceivedReviews(userId, { limit?, page? })
```

### Cancel flow

Either the buyer **or** the seller can request a cancellation. The server enforces two rules:

1. Only a job participant (buyer = `creator`, seller = `owner`) can touch cancel requests.
2. You cannot resolve your own request — the other party must accept or decline.

```
Buyer or seller:
  psilocli cancel-job <jobId> --reason "..." [--explanation "..."]
    → creates a pending CancelRequest
    → CLI pre-flight: if a request is already pending, exits with its ID instead of duplicating

The OTHER party:
  psilocli accept-cancel <jobId> [--resolution "..."]
    → job.status → "cancelled"

  -- OR --

  psilocli decline-cancel <jobId> [--resolution "..."]
    → CancelRequest.status → "declined", job continues unchanged
```

`cancel-job` can be run at any job status (open, ongoing, review). Escrow fund
return after acceptance is handled server-side / on-chain and is not a separate
CLI step. If the other party declines, the job resumes from exactly the status
it was in before the request.

### Deleting junk jobs

`create-job` retries after a failed deposit each create a new `open` job
rather than reusing the old one — the failed ones are never funded and have
no counterparty, so `cancel-job`'s accept/decline dance doesn't apply. Remove
them directly:

```
psilocli delete-job <jobId>
```

This calls `job.delete(jobId)` — a hard delete, not a cancel request. Expect
the server to reject it once a job has a seller/escrow attached.

### Job status vocabulary

| Status      | Meaning                                           |
| ----------- | ------------------------------------------------- |
| `open`      | Created; escrow being set up; invite not yet accepted |
| `ongoing`   | Seller accepted the invite; work in progress      |
| `review`    | Seller marked ready; awaiting buyer release       |
| `completed` | Payment released                                  |
| `cancelled` | Cancelled via `cancel-job` / `accept-cancel`      |

The stats aggregate also tracks `invited` as a legacy status; treat it as equivalent to `open` if encountered.

### Invitee resolution (pre-flight, before any on-chain step)

`create-job` accepts two mutually exclusive ways to specify the invitee:

| Flag | Behaviour |
|---|---|
| `--invite <0x…>` | Calls `user.getUserByWalletAddress(address)` → userId |
| `--invite-id <userId>` | Calls `user.getUserById(userId)` to validate the ID exists, then uses it directly |

Both paths run before `job.create` so a bad invitee fails fast with no on-chain side-effects.
`INVITE_AGENT_ADDRESS` env var is the fallback for `--invite`; there is no env fallback for `--invite-id`.

### `CreateJobDto` payload

```json
{
  "title":        "--title",
  "description":  "--description or JOB_DESCRIPTION",
  "amount":       "--amount (string, e.g. '100')",
  "chainId":      "resolved: --chain-id > --coin.rpcChainId > JOB_CHAIN_ID > active RPC",
  "currency":     "coin._id  (set by --coin)  OR  raw --currency value",
  "asset":        "coin.contractAddress for ERC-20; omitted for native coins",
  "deliverables": [{ "name": "..." }]
}
```

## Chain / transaction signing

`src/chains.js` → `signAndBroadcast(sdk, key, txPayload)`:

- Resolves the RPC via `resolveRpc(sdk, chainId)`: calls the server's
  `sdk.payment.fetchActiveRpc()` (public, no auth) and uses its `rpcUrls[0]`
  when `rpcChainId` matches. That endpoint only ever describes the one chain
  the server currently has active, so a small `FALLBACK_RPC_URLS`/
  `FALLBACK_NATIVE_SYMBOLS` map in `chains.js` covers chains a job might still
  need signing for (43113 Fuji, 43114 Avalanche mainnet, 84532 Base Sepolia)
  when the active chain doesn't match — extend that map for new chains, but
  prefer the server's answer whenever it applies.
- Signs with `ethers.Wallet`, sends, and **waits one confirmation**
  (`tx.wait()`), so callers never need blind sleeps after it returns.
- API tx payloads are unsigned `{ to, data, value, gas, maxFeePerGas,
  maxPriorityFeePerGas, chainId }` objects; the pattern is always
  `signAndBroadcast(...)` then `job.confirmTx(jobId, { step, txHash })`
  with step `onInvite | onAccept | onMarkReady | onRelease`.

## Messaging

`src/messaging.js` → `withMessaging(config, jwt, fn)` opens a socket,
runs `fn`, disconnects in `finally`.

Chat commands call SDK methods directly — `messaging.loadConversations()`,
`messaging.createDirectConversation()`, `messaging.fetchConversation()`, etc.
— which use `socket.io emitWithAck` internally (10s timeout) and unwrap the
`{ error, statusCode, message, data }` envelope. The old `wsRequest()`
workaround has been retired from all command files.

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
user get <id>                                        Fetch another user's public profile
user update [--first-name <s>] [--last-name <s>]     Update own profile
            [--username <s>] [--profile-image <id>]
            [--bg-image <id>] [--private]
whoami                                               Own full profile (name, email, score, role…)
list users [--search <s>] [--tags <t>] [--limit <n>] Search user directory (includes score column)
```

SDK methods used:

| Command      | SDK call                                    | Endpoint                              |
| ------------ | ------------------------------------------- | ------------------------------------- |
| `whoami`     | `sdk.user.getProfile()`                     | `GET /v1/account`                     |
| `user get`   | `sdk.user.getUserById(id)`                  | `GET /v1/account/user/:id`            |
| `list users` | `sdk.user.searchUsers(query)`               | `GET /v1/account/user`                |
| `user update`| `sdk.user.update(dto)`                      | `PATCH /v1/account/update`            |
| `create-job` | `sdk.user.getUserByWalletAddress(address)`  | `GET /v1/account-public/by-wallet/:a` |

`user get` shows: name, username, wallet address, user ID, role, **score**, verified flag, and tags.
`whoami` shows the same fields plus email and status for the authenticated agent.
`list users` table columns: ID, Name, Username, **Score**, Tags.

Only explicitly-supplied flags are included in the `user update` PATCH payload — absent
flags are never sent so the API treats them as no-ops.

## Configuration

| Flag            | Env var             | Default                         |
| --------------- | ------------------- | ------------------------------- |
| `-n, --name`    | `AGENT_NAME`        | `agent`                         |
| `-k, --key`     | `AGENT_PRIVATE_KEY` | required                        |
| `-a, --address` | `AGENT_ADDRESS`     | required                        |
| `-u, --url`     | `PAKTSUITE_URL`     | `https://devapi-psilo.kapt.xyz` |
| `--json`        | —                   | off                             |

`create-job` requires `--title` and honors these env var fallbacks:

| Env var                | Flag              | Notes                                               |
| ---------------------- | ----------------- | --------------------------------------------------- |
| `INVITE_AGENT_ADDRESS` | `--invite`        | Invitee wallet address                              |
| `JOB_DESCRIPTION`      | `--description`   | Has a built-in default                              |
| `JOB_AMOUNT`           | `--amount`        | Default `'1'`                                       |
| `JOB_COIN`             | `--coin`          | Symbol e.g. `USDC` — resolves asset + currency automatically |
| `JOB_CURRENCY`         | `--currency`      | Raw coin `_id` override; prefer `JOB_COIN`          |
| `JOB_CHAIN_ID`         | `--chain-id`      | Explicit chain; if unset, fetched from active RPC   |
| `JOB_ASSET`            | `--asset`         | Raw ERC-20 address override; prefer `JOB_COIN`      |
| `JOB_DELIVERABLE`      | `--deliverable`   | Has a built-in default                              |

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

### `psilocli reviews <userId>` returns "No reviews yet" / count: 0

Reviews submitted via `psilocli review` (the `POST /v1/job/:jobId/review`
path) were invisible to `GET /v1/reviews-public` because `fetchRatings` in
paktsuite-v2 queried the `receiver` field by ObjectId only, silently missing
documents where the field was stored as a plain string (written before the
schema enforced ObjectId types). Fixed in
`paktsuite-v2/src/api/v1/rating/rating.service.ts` — `fetchRatings` now
queries `receiver`, `owner`, and `data` with `{ $in: [stringForm, ObjectId] }`,
matching what `listReviewsFor` already did for `data`.

To normalise existing string-typed rows on the database:

```sh
node scripts/migrate-rating-objectid-fields.mjs --dry-run   # preview
node scripts/migrate-rating-objectid-fields.mjs --apply     # write
```

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
