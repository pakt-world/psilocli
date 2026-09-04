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
│  ethers.js         ←→  EVM chain (multi-chain, dynamic)  │
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
| `publicRpcUrls` | RPC endpoints for signing transactions (used by `resolveRpc`) |
| `nativeCurrency` | `{ name, symbol, decimals }`                               |
| `isDefault`    | True for the chain used when no `chainId` is sent            |
| `factoryAddress` | Escrow factory contract address                            |

`resolveRpc(sdk, chainId?)` in `src/chains.js` now uses `fetchAvailableChains()` — it finds the chain by `chainId`, or picks `isDefault` when no `chainId` is given. This means signing works for any available chain, not just the server's currently-active one.

`fetchPaymentCoins()` returns `PaymentCoin[]`. Each record has:

| Field               | Meaning                                              |
| ------------------- | ---------------------------------------------------- |
| `_id`               | The ID the server expects in `CreateJobDto.currency` |
| `symbol`            | Human-readable ticker (e.g. `USDC`, `AVAX`)          |
| `contractAddress`   | ERC-20 address on whatever chain `fetchPaymentCoins()` defaulted to server-side (or the chain you passed as `chainId`/`rpcId`); absent on native coins. Don't use this alone to resolve a job's asset for a specific chain — use `contractAddresses[chainId]` (see `--coin` resolution below) |
| `contractAddresses` | Map of `{ chainId: contractAddress }` across every chain the coin is deployed on — used by `resolveAssetSymbol` (see below) to look up a job's token from its `asset` field |
| `isToken`           | `true` = ERC-20, `false` = native coin               |
| `minAmount`         | Smallest `--amount` this coin accepts, in whole token units (e.g. `10` for USDC). Enforced server-side in `makeDeposit`, not in `job.create` — see below |
| `rpcChainIds`       | Array of chain IDs this coin is active on (strings)  |
| `active`            | Only active coins are usable                         |

### `--coin <symbol>` resolution in `create-job`

`--coin` (or `JOB_COIN` env var) is the preferred way to specify payment. It
auto-resolves three fields so you don't have to look them up manually. Order
below matches `create-job.js:265-294` exactly — keep this list and that code
in sync if either changes:

1. (`create-job.js:266-269`) Fetches all active coins via `fetchPaymentCoins()` (no chain
   filter), finds one whose `symbol` matches (case-insensitive).
2. (`create-job.js:279-284`) Validates `amount >= coin.minAmount` — see "Minimum
   escrow amount" below. Fails with a usage error (exit 2) before anything
   else runs if it's too low.
3. (`create-job.js:285`) Sets `currency = coin._id` — **the server stores the coin
   record's `_id`, not the symbol**.
4. (`create-job.js:286-290`) Resolves `chainId`: `--chain-id` if given (warns and
   falls back to `coin.rpcChainIds[0]` if that chain isn't in `coin.rpcChainIds`),
   else `coin.rpcChainIds[0]`.
5. (`create-job.js:292`) Sets `asset = coin.contractAddresses?.[chainId] ?? coin.contractAddress
   ?? ''` for ERC-20 tokens, `''` for native coins — looked up against the
   chainId resolved in step 4, **not** the flat `contractAddress` field alone.
   Fixed 2026-09-03 (commit `c84a683`): the flat `contractAddress` reflects
   whatever chain the chain-less `fetchPaymentCoins()` call defaults to
   server-side (observed: Base Sepolia, 84532), so using it unconditionally
   silently funded the escrow with a contract address that doesn't exist on
   a non-default `--chain-id` — `approve` succeeded meaninglessly against an
   EOA, then deposit reverted. Re-verified live 2026-09-04: `--coin USDC
   --chain-id 43113` now correctly prints the Fuji contract
   (`0x5425890298...Bc65`), not the Base Sepolia one (`0x036CbD53...F7e`).

### Minimum escrow amount

Each coin carries its own `minAmount` (currently: USDC = `10`). Before
2026-09-04 (PSILO-8) this was only enforced server-side, inside
`makeDeposit` — well after `job.create()` had already made a real job
record. Every under-minimum attempt left a dangling unfunded `open` job that
had to be cleaned up with `delete-job`, and the minimum itself appeared
nowhere in `--help`, README, or here.

Fixed by validating `amount >= coin.minAmount` immediately after resolving
the coin (`create-job.js:279-284`), before `job.create()` is ever called.
Verified live: `--amount 5 --coin USDC` now fails immediately with `Amount 5
is below USDC's minimum of 10.` and exit code 2 — no job record created, no
`delete-job` cleanup needed. The boundary is inclusive: `--amount 10` (or
above) passes.

This check only runs when `--coin` is used — there's no `minAmount` to check
against on the raw `--currency`/manual path, since that data lives on the
coin record `--coin` looks up.

Only one coin (USDC) is active on this server as of this writing, so it's
unconfirmed whether `minAmount` genuinely varies per coin or every coin
happens to carry the same value — the field is structurally per-coin either
way, so the check is written generically (`coin.minAmount`, not a hardcoded
`10`).

If neither `--coin` nor `--chain-id` nor `JOB_CHAIN_ID` is set, `create-job`
calls `resolveRpc(sdk, null)` which picks the `isDefault` chain from
`fetchAvailableChains()`.

## Job listing (`sdk.job.list`)

```sh
psilocli list jobs --status open --limit 20           # public job board
psilocli list jobs --status open --limit 20 --owner    # only jobs you created
```

`GET /v1/job` is a **public job board** — without `--owner`, it returns every
job matching `status`/`limit` regardless of who created it, including jobs
flagged `isPrivate: true`. This was previously misdiagnosed (an earlier
version of this doc claimed `role`/`owner=true` fixed the scoping and that
PSILO-1/PSILO-2 were "working as intended" — that was wrong).

Root cause: the CLI used to send `role` and `owner=true` as query params, but
the SDK's `ListJobsQuery` type has no such fields — only `creator`, `buyer`,
`seller`, `chainId`, `page`, `limit` are real. `role`/`owner` were silently
ignored by the API, so every `list jobs` call — with or without `--owner` —
returned the same unscoped public board. Confirmed live: a brand-new wallet
with zero jobs got back 74 other people's completed jobs regardless of
`--role buyer` vs `--role seller`.

Fixed by dropping `role`/`owner` from the request and sending the real field
instead: `--owner` now adds `creator: <your userId>` to the query, which
*does* scope correctly (verified live — a fresh wallet with no jobs gets
`[]`). Caveat: `creator` only covers jobs **you created** (the buyer side).
If you're the seller (assigned talent) on someone else's job, `--owner`
won't surface it — there's no confirmed single filter for "jobs I'm a party
to regardless of side." Without `--owner`, you still get the full unscoped
public board, including private jobs — that's a backend authorization gap
the CLI can't fix client-side; filtering the response after the fact
wouldn't stop the server from having sent the data.

### Token column resolution

An earlier version of this doc claimed `job.currency` was frequently `null`
for a "known batch" of jobs created between 2026-07-02 and 2026-07-20, and
told readers not to re-investigate. That's stale — re-checked live on
2026-09-04 across 195 jobs spanning every status (including that exact date
range) and `currency` was populated and correct on all of them. Don't trust
"legacy data, not a live bug" as settled; if a `currency: null` record shows
up again, treat it as new evidence, not a known issue.

`list jobs`' Token column still doesn't trust `currency` alone, since a
`null` value remains possible in principle even if not currently observed —
`j.currency?.symbol ?? resolveAssetSymbol(coins, chains, j)` in
`src/commands/list.js:49` falls back to `resolveAssetSymbol(coins, chains,
job)` in `src/chains.js`. The branches below are listed in the exact order
the code checks them — keep this list and the function body in sync if
either changes:

1. (`list.js:49`) If `job.currency.symbol` is present, use it directly — `resolveAssetSymbol` isn't even called.
2. (`chains.js:94-97`) Else, if `job.asset` is empty, the job is funded in the chain's native
   token — resolve `chain.nativeCurrency.symbol` from `fetchAvailableChains()`,
   or `'?'` if `job.chainId` doesn't match any known chain.
3. (`chains.js:98-101`) Else match `job.asset` against `coins[].contractAddresses[job.chainId]`
   (exact chain match) — use that coin's symbol.
4. (`chains.js:102-105`) Else match `job.asset` against `contractAddresses` on *any* chain (loose
   match — a small number of historical records have their contract address
   registered under the wrong chainId key) — use that coin's symbol.
5. (`chains.js:106`) Else, fall back to a truncated `asset` address rather than guessing a
   symbol (the old code hardcoded `'AVAX'` here, which was wrong ~95% of the
   time on sampled data — never reintroduce that fallback).

Note this can only resolve what the API gives it: on the public board,
`asset` is absent from every record (steps 2/3 never match), but that's
currently harmless because `currency` is populated on public-board records
too, so step 1 resolves it directly. If a future record has both `currency`
and `asset` missing, the Token column falls through to the native-currency
branch and may show the wrong symbol for an ERC-20 job — that failure mode
is unverified today, not confirmed-happening.

## Job lifecycle and SDK calls

```
Buyer                                Seller
─────────────────────────────────────────────────────────────────────
Pre-flight (optional):
  list chains  → sdk.payment.fetchAvailableChains()
  list coins   → sdk.payment.fetchPaymentCoins()
  list jobs    → sdk.job.list({ status, limit, creator? })   (public board unless --owner)

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

                         list invites → job.listAllInvites()     (--pending: client-side filter, see below)
                         accept-invite:
                           job.getInvites(jobId)            pre-flight: reject if invite missing/not pending
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

### Invite listing and acceptance

`list invites` returns **every** invite regardless of status —
`sdk.job.listAllInvites()`'s query type (`ListAllInvitesQuery`) is `{ page?,
limit? }` only, no `status` field exists server-side to filter on. An
account with any history will see `pending`, `accepted`, `cancelled`, etc.
all mixed together (confirmed live 2026-09-04: 20 invites, only 7 pending).
This bit a real agent (PSILO-7): it treated the full list as its open work
and re-accepted a job it already held.

`--pending` (added 2026-09-04) filters to `status === 'pending'` — but this
is a **client-side** filter over the same full response, not a narrower
query; it doesn't reduce what's fetched, and an invite can still flip status
between this call and a later `accept-invite` call. Without `--pending`, a
stderr note says so explicitly.

```
psilocli list invites            # every invite, every status (note printed)
psilocli list invites --pending  # only status === "pending"
```

`accept-invite <jobId> <inviteId>` now pre-flights with `job.getInvites(jobId)`
before calling `acceptInvite`, failing with a specific message if the invite
is missing or already resolved:

```
Error: Invite <id> is not pending (status: "accepted") — nothing to accept.
Error: No invite <id> found on job <jobId>.
```

This narrows the race window and gives a clearer error than the API's own
`"No pending invitation found for this user"` — it does **not** close the
race (classic time-of-check-to-time-of-use gap: status can still change
between this check and the `acceptInvite` call three lines later). The
server's own rejection, confirmed live, is what actually prevents a second
signed accept from going through; this guard is a UX improvement layered on
top of it, not the safety mechanism itself.

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
  "amount":       "--amount (string, e.g. '100') — validated against coin.minAmount when --coin is used, before this DTO is built",
  "chainId":      "resolved: --chain-id > --coin.rpcChainIds[0] > JOB_CHAIN_ID > resolveRpc(sdk, null)",
  "currency":     "coin._id  (set by --coin)  OR  raw --currency value",
  "asset":        "coin.contractAddresses[chainId] ?? coin.contractAddress for ERC-20; omitted for native coins",
  "deliverables": [{ "name": "..." }]
}
```

## Chain / transaction signing

`src/chains.js` → `signAndBroadcast(sdk, key, txPayload, rpcOverride = null)`:

- Resolves the RPC via `resolveRpc(sdk, chainId)`: calls
  `fetchAvailableChains()` and returns `chain.publicRpcUrls[0]` for the
  matched chain (or the `isDefault` chain when no `chainId` is given). No
  hardcoded fallback URLs — all RPC endpoints are server-sourced.
- Pass `rpcOverride` (from `--rpc <url>`) to bypass the server-provided URL.
  Useful when `publicRpcUrls[0]` is rate-limited (e.g. Tenderly free tier).
  Every command that calls `signAndBroadcast` exposes `--rpc`: `create-job`
  (incl. `--resume`), `accept-invite`, `complete-job`, `release-payment`.
- Signs with `ethers.Wallet`, sends, and **waits one confirmation**
  (`tx.wait()`), so callers never need blind sleeps after it returns.
- API tx payloads are unsigned `{ to, data, value, gas, maxFeePerGas,
  maxPriorityFeePerGas, chainId }` objects; the pattern is always
  `signAndBroadcast(...)` then `job.confirmTx(jobId, { step, txHash })`
  with step `onInvite | onAccept | onMarkReady | onRelease`.

## Messaging

`src/messaging.js` → `withMessaging(config, jwt, fn)` opens a socket,
runs `fn`, disconnects in `finally`.

`messages.js` commands call SDK methods directly — `messaging.loadConversations()`,
`messaging.createDirectConversation()`, `messaging.fetchConversation()`, etc.
— which use `socket.io emitWithAck` internally (10s timeout) and unwrap the
`{ error, statusCode, message, data }` envelope. Verified live 2026-09-04:
`INITIALIZE_CONVERSATION` now acks fine, so these direct calls work.

`wsRequest()` in `src/messaging.js` is **not** retired — `complete-job.js`'s
`sendToCreator()` still uses it for `INITIALIZE_CONVERSATION`/`SEND_MESSAGE`
instead of calling `messaging.createDirectConversation()`/`sendMessage()`
directly like `messages.js` does. That's a leftover from before the ack bug
below was fixed — harmless (still works), just an inconsistency with the
rest of the codebase. Don't reintroduce `wsRequest()` in new code; the
direct SDK methods work now.

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
| `JOB_CHAIN_ID`         | `--chain-id`      | Explicit chain; if unset, resolved from `fetchAvailableChains()` isDefault |
| `JOB_DELIVERABLE`      | `--deliverable`   | Has a built-in default                              |

`--asset`/`JOB_ASSET` were removed (2026-09-04, PSILO-6): a raw asset
override sat alongside `--coin`'s own asset resolution with no conflict
check, so passing both silently discarded whichever one `--coin`'s branch
ran last — always `--coin`'s value, regardless of intent. `asset` is now
resolvable only through `--coin`; there's no second path to conflict with
it. If you need a token `--coin` can't resolve (not in the platform's coin
registry), that's not supported via the CLI right now.

## Output discipline

- stdout: command output only — human tables via `cliTable()` or `--json`
  via `out()`. `messages watch --json` emits NDJSON.
- stderr: progress/diagnostics via `note()`, errors via `fail(msg, code)`.
- Exit codes: 0 success, 1 error, 2 usage error (strict parseArgs makes
  unknown flags a usage error).

## Common errors and fixes

### `--key / AGENT_PRIVATE_KEY is required`

Export `AGENT_PRIVATE_KEY` and `AGENT_ADDRESS`, or pass `-k`/`-a`.

### `Chain <id> is not available on this server`

The requested `chainId` isn't in the server's `GET /v1/payment/chains`
response, or `publicRpcUrls` is empty for that chain. Run
`psilocli list chains --json` to see what the server currently exposes.
Use `--rpc <url>` to supply an RPC endpoint directly if the server omits it.

### `validatePayment attempt n/6 failed`

Deposit not yet indexed by the API. The loop retries every 10s; if all 6
fail, check the deposit tx hash on the explorer and re-run
`psilocli create-job` — or fund the wallet if the deposit never went out.

### `No releasePayload returned — job may not be in review status`

`release-payment` only works after the seller's `complete-job` confirmed
`onMarkReady`. Check `psilocli list jobs --status ongoing --owner`
(`--owner` is required — without it, the API returns the public job board,
not just jobs you created; and `--owner` only surfaces jobs where you're the
buyer, not jobs where you're the seller).

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

**Fixed — this error should no longer occur.** This was a known
deployed-server bug (as of July 2026, devapi): the `INITIALIZE_CONVERSATION`
handler never sent its acknowledgement, so `messages send --to` and group
creation couldn't open new conversations. Re-verified live on 2026-09-04:
`INITIALIZE_CONVERSATION` acks correctly now, both via `messaging.createDirectConversation()`
(`messages send --to <userId>` works end to end) and via a raw `wsRequest()`
call. If this error resurfaces, it's a regression, not the same known issue
— investigate fresh rather than assuming "pending redeploy."

## Adding a command

1. Create `src/commands/<verb>.js` exporting `usage` and `run(argv)`.
2. Parse flags with `parseCommand(argv, options, { positionals })`,
   resolve auth with `resolveConfig(values)`, init with `cliInit(config)`.
3. Register it in `COMMANDS` and the help text in `bin/psilocli.mjs`.
4. Support `--json` (via `config.json`) and keep stdout/stderr discipline.
