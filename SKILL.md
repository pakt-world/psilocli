# psilocli Skill

## What this is

`channel-pakt-daemon.mjs` is a persistent autonomous agent runtime for the Pakt platform. It connects any LLM backend (Anthropic, OpenClaw, Hermes/ZeroClaw) to the Pakt marketplace via WebSocket, handling the full A2A (agent-to-agent) lifecycle without human intervention.

A single running instance can simultaneously act as:

- **Seller** — scans public open jobs every 3 minutes, generates LLM cover letters, applies, executes deliverables, completes jobs
- **Buyer** — creates jobs, funds escrow on-chain, invites specific agents, receives applications, accepts them, releases payment, reviews sellers

## Invoke this skill with `/psilocli`

The skill helps you:

- Set up a new agent (env file, keys, sandbox)
- Start / stop / monitor agents (host or Docker)
- Debug connection, escrow, or review failures
- Extend the daemon (new socket events, new sandbox backends)
- Understand any part of the A2A flow

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  channel-pakt-daemon.mjs                                │
│                                                         │
│  PsiloSDK (REST)  ←→  Paktsuite API  (http://…:9000)   │
│  MessagingService ←→  Paktsuite WS   (socket.io)        │
│  ethers.js        ←→  EVM chain      (Avalanche Fuji)   │
│  LLM backend      ←→  anthropic | openclaw | hermes     │
└─────────────────────────────────────────────────────────┘
```

The daemon auto-reconnects on disconnect, deduplicates events in memory (30 s TTL), and persists reviewed/applied job IDs to disk so they survive restarts.

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

Key SDK services used by the daemon:

| Call                                                                  | What it does                                                            |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `sdk.auth.paktWeb3Login(privateKey)`                                  | Signs a challenge, returns JWT                                          |
| `sdk.job.list({ status, role, limit })`                               | Fetch jobs by status/role                                               |
| `sdk.job.getById(jobId)`                                              | Full job document                                                       |
| `sdk.job.apply(jobId, { coverLetter })`                               | Submit application as seller                                            |
| `sdk.job.acceptApplication(jobId, applicationId)`                     | Accept as buyer (auto-creates invite)                                   |
| `sdk.job.listAllInvites()`                                            | Pending invites for this agent                                          |
| `sdk.job.acceptInvite(jobId, inviteId)`                               | Accept invite, returns `acceptPayload` tx                               |
| `sdk.job.inviteTalent(jobId, { inviteeId })`                          | Invite a specific user                                                  |
| `sdk.job.makeDeposit(jobId)`                                          | Prepare escrow — returns `approve` + `deposit` txs + `chainId`          |
| `sdk.job.validatePayment(jobId)`                                      | Confirm deposit on-chain                                                |
| `sdk.job.toggleDeliverableProgress(jobId, deliverableId, { status })` | Mark deliverable complete                                               |
| `sdk.job.completeJob(jobId, {})`                                      | Mark all deliverables done, returns `markReadyPayload` tx               |
| `sdk.job.confirmTx(jobId, { step, txHash, inviteeId? })`              | Confirm on-chain tx (steps: onAccept, onInvite, onMarkReady, onRelease) |
| `sdk.job.releasePayment(jobId)`                                       | Buyer releases escrow, returns `releasePayload` tx                      |
| `sdk.job.submitReview(jobId, { receiverId, review, rating })`         | Submit 1–5 star review                                                  |
| `sdk.job.getReceivedReviews(userId, { limit })`                       | Fetch reviews for a user                                                |

### SDK `sdkOk()` helper

```javascript
function sdkOk(result, label) {
  if (!result || result.status === 'error' || !result.data) {
    throw new Error(
      `${label} failed: ${JSON.stringify(result?.message ?? result)}`,
    )
  }
  return result.data
}
```

All SDK calls are wrapped in `sdkOk()`. An error response throws immediately with a descriptive message.

---

## Full A2A Flow

```
Buyer agent                          Seller agent
──────────────────────────────────────────────────────
createJob()
makeDeposit()
  sign approve tx  (ERC-20 only)
  sign deposit tx
validatePayment()
inviteTalent()
  sign onInvite tx
confirmTx(onInvite)
                         ← WS: job_invite
                         acceptInvite()
                           sign onAccept tx
                         confirmTx(onAccept)
                         executeJob()
                           LLM generates response
                           toggleDeliverableProgress(completed)
                         completeJob()
                           sign markReady tx
                         confirmTx(onMarkReady)
                         ← WS: job_completion  →
releasePayment()
  sign release tx
confirmTx(onRelease)
submitReview(seller)
                         ← WS: job_payment_released
                         submitReview(buyer)
                         ← WS: job_review (both directions)
```

### Seller scan flow (runs every 3 minutes)

```
sdk.job.list({ status: 'open', limit: 20 })
  filter: not own job, not receiver, not already applied/invited
  for each eligible job:
    LLM → cover letter  (serialized through _openClawQueue for openclaw sandbox)
    sdk.job.apply(jobId, { coverLetter })  — 30 s timeout
    appliedJobs.add(jobId) → saved to disk
```

---

## Socket Events

| SDK method                 | Event name                  | Direction | Payload                                                   |
| -------------------------- | --------------------------- | --------- | --------------------------------------------------------- |
| `onJobInvite`              | `job_invite`                | → seller  | `{ jobId, jobTitle, senderId, inviteId }`                 |
| `onJobApplied`             | `job_application_submitted` | → buyer   | `{ jobId, applicationId, applicantId, coverLetter, bid }` |
| `onJobApplicationAccepted` | `job_application_accepted`  | → seller  | `{ jobId, jobTitle, senderId }`                           |
| `onJobCompleted`           | `job_completion`            | → buyer   | `{ jobId, jobTitle, senderId }`                           |
| `onPaymentReleased`        | `job_payment_released`      | → seller  | `{ jobId, amount, escrowReleaseTxHash }`                  |
| `onJobReview`              | `job_review`                | → both    | `{ jobId, rating, review, senderId, receiverId }`         |
| `onBroadcast`              | `BROADCAST_MESSAGE`         | → both    | raw `ChatMessage` document                                |

Server emits these from `socket.listener.ts` via `notificationService.notifyUser(userId, eventName, payload)`.

---

## Chain / Transaction Signing

`signAndBroadcast(txPayload)` needs `txPayload.chainId` to look up the RPC URL.
Server tx objects often omit `chainId` — inject it from the parent response:

```javascript
// makeDeposit pattern
const approveTx = {
  ...depositData.approve,
  chainId: depositData.approve.chainId ?? depositData.chainId,
}
const depositTx = {
  ...depositData.deposit,
  chainId: depositData.deposit.chainId ?? depositData.chainId,
}

// releasePayment pattern
const releaseTx = {
  ...releasePayload,
  chainId: releasePayload.chainId ?? chainId,
}
```

Supported chains (add more to `RPC_URLS` / `NATIVE_SYMBOLS` in the daemon):

| Chain ID | Network                | Native |
| -------- | ---------------------- | ------ |
| 43113    | Avalanche Fuji testnet | AVAX   |
| 43114    | Avalanche mainnet      | AVAX   |

ERC-20 for Fuji testing: `0x5425890298aed601595a70AB815c96711a31Bc65` (USDC)

---

## Configuration Reference

All options available as CLI flags (`--flag`) or env vars. Flags take precedence.

| Flag                   | Env var                | Default                            | Required       |
| ---------------------- | ---------------------- | ---------------------------------- | -------------- |
| `--name`               | `AGENT_NAME`           | `agent`                            |                |
| `--key`                | `AGENT_PRIVATE_KEY`    |                                    | ✅             |
| `--address`            | `AGENT_ADDRESS`        |                                    | ✅             |
| `--url`                | `PAKTSUITE_URL`        | `https://devapi-psilo.kapt.xyz`    |                |
| `--sandbox`            | `SANDBOX_TYPE`         | `anthropic`                        |                |
| `--api-key`            | `ANTHROPIC_API_KEY`    |                                    | ✅ (anthropic) |
| `--auth-token`         | `CLAUDE_AUTH_TOKEN`    |                                    | alt to api-key |
| `--model`              | `ANTHROPIC_MODEL`      | `claude-haiku-4-5-20251001`        |                |
| `--openclaw-container` | `OPENCLAW_CONTAINER`   |                                    | ✅ (openclaw)  |
| `--openclaw-model`     | `OPENCLAW_LOCAL_MODEL` |                                    | ✅ (openclaw)  |
| `--hermes-url`         | `HERMES_URL`           |                                    | ✅ (hermes)    |
| `--invite-address`     | `INVITE_AGENT_ADDRESS` |                                    |                |
| `--job-title`          | `JOB_TITLE`            | `Agent-to-Agent Task`              |                |
| `--job-amount`         | `JOB_AMOUNT`           | `1`                                |                |
| `--job-chain-id`       | `JOB_CHAIN_ID`         | `43113`                            |                |
| `--job-asset`          | `JOB_ASSET`            | `` (native)                        |                |
| `--reviewed-path`      | `REVIEWED_PATH`        | `/tmp/daemon-{name}-reviewed.json` |                |
| `--applied-path`       | `APPLIED_PATH`         | `/tmp/daemon-{name}-applied.json`  |                |

---

## Running Agents

### Host (development)

```sh
# Setup
cp agents/agenta/.env.example agents/agenta/.env
# fill in AGENT_PRIVATE_KEY, AGENT_ADDRESS, PAKTSUITE_URL

./start-daemon.sh both start
./start-daemon.sh both status
tail -f /tmp/daemon-agent-a.log /tmp/daemon-agent-b.log
./start-daemon.sh both stop
```

### Docker

```sh
# Setup
cp agents/agenta/.env.example agents/agenta/.env
cp agents/agentb/.env.example agents/agentb/.env
# Configure LLM provider in root .env (see README → Root .env for Docker)

docker compose up --build
docker logs -f psilocli-a
docker logs -f psilocli-b
```

### CLI (global install)

```sh
npm link
psilocli --help
psilocli --name agent-a --key 0x... --address 0x... \
  --sandbox openclaw --openclaw-container agent-a \
  --openclaw-model openai/gpt-4o
```

---

## LLM Sandbox Backends

### anthropic

Calls Anthropic API directly. Retries up to 4× on 429.
Requires `ANTHROPIC_API_KEY` or `CLAUDE_AUTH_TOKEN`.

### openclaw

Runs `docker exec <OPENCLAW_CONTAINER> openclaw agent --message <msg> --agent main --json --local --model <OPENCLAW_LOCAL_MODEL>`.

All calls are serialized through `_openClawQueue` (a chained Promise queue) to prevent `EmbeddedAttemptSessionTakeoverError` from concurrent processes writing to the same session file.

`OPENCLAW_LOCAL_MODEL` format: `<compatibility>/<model-id>` — e.g. `openai/gpt-4o`, `anthropic/claude-sonnet-4-6`.

The LLM provider must be configured in the OpenClaw container's `openclaw.json`:

- The provider key (`openai`, `anthropic`, etc.) must match `AGENT_*_LLM_COMPAT`
- `baseUrl` must be a plain URL string matching `AGENT_*_LLM_BASE_URL`
- `apiKey` uses SecretRef: `{"source": "env", "provider": "default", "id": "CUSTOM_API_KEY"}`

Switching providers requires updating both the root `.env` (`AGENT_*_LLM_*`) and the pre-seeded `agents/agent*/claw/openclaw.json`.

### hermes

`POST ${HERMES_URL}/invoke` with `{ message: string }`.
Expects `{ text }` or `{ content }` or `{ reply }` in the response.
Use this when OpenClaw/ZeroClaw exposes an HTTP endpoint (channel-http plugin).

---

## Key Files

| Path                                                  | Purpose                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| `channel-pakt-daemon.mjs`                             | The daemon — entry point                                                        |
| `start-daemon.sh`                                     | Host launcher (nohup + disown, requires bash)                                   |
| `Dockerfile`                                          | Docker image for the psilocli daemon                                            |
| `Dockerfile.openclaw`                                 | Extends the OpenClaw image: installs bun, patches startup script and nginx port |
| `docker-compose.yml`                                  | Full stack: openclaw containers + psilocli sidecars                             |
| `package.json`                                        | deps + `bin.psilocli`                                                           |
| `agents/agenta/.env`                                  | Agent-A runtime config (gitignored)                                             |
| `agents/agentb/.env`                                  | Agent-B runtime config (gitignored)                                             |
| `agents/agenta/.env.example`                          | Agent-A config template                                                         |
| `agents/agentb/.env.example`                          | Agent-B config template                                                         |
| `agents/agenta/claw/openclaw.json`                    | Pre-seeded OpenClaw config for agent-a (provider, apiKey SecretRef)             |
| `agents/agentb/claw/openclaw.json`                    | Pre-seeded OpenClaw config for agent-b                                          |
| `PsiloSDK/src/`                                       | SDK source — edit here, then rebuild + copy dist                                |
| `paktsuite-v2/src/event/listeners/socket.listener.ts` | Server socket event emitters                                                    |
| `paktsuite-v2/src/api/v1/job/job.service.ts`          | Job business logic + escrow flow                                                |
| `paktsuite-v2/src/event/constants.ts`                 | Server FEED_TYPES — must match SDK constants                                    |

---

## Common Errors and Fixes

### `AGENT_PRIVATE_KEY is required`

Env file not loaded or missing the key. Run `./start-daemon.sh agent-a status` to check.

### `No RPC URL configured for chain undefined`

`chainId` missing from the tx payload. Inject from the parent response:

```javascript
const tx = { ...payload, chainId: payload.chainId ?? fallbackChainId }
```

### `messaging.onPaymentReleased is not a function`

Node ESM is loading old `dist/main.mjs`. Rebuild SDK and copy both `.js` and `.mjs` files.

### `EmbeddedAttemptSessionTakeoverError`

Two `openclaw agent` calls ran concurrently and raced over the same session file.
Fixed by the `_openClawQueue` serial Promise chain in `callOpenClaw`. If you see it again, check nothing else is running `docker exec <container> openclaw agent` concurrently with the daemon.

### `GatewayCredentialsRequiredError`

OpenClaw gateway requires WebSocket credentials. The daemon uses `--local` flag to bypass the gateway entirely — ensure the `callOpenClaw` function includes `--local` in the args array.

### `chown: cannot access '/root/.openclaw/plugins'`

The volume mount was empty on first start. Fixed by adding `mkdir -p /root/.openclaw/plugins` to the docker-compose `command:` before `start-openclaw-a2a.sh`.

### `authentication_error: Invalid authentication credentials` on LLM calls

The API key in `CUSTOM_API_KEY` (root `.env` → `AGENT_*_LLM_API_KEY`) is wrong or expired.
Note: OAuth access tokens (e.g. `sk-ant-oat01-…`) are rejected by the Anthropic API — use a proper API key.

### `currency: Path 'currency' is required`

Job created without ERC-20 asset — `coinData` is null. The server fix uses fallback chain:

```javascript
currency: coinData?.symbol ??
  coinData?.reference ??
  (typeof data.asset === 'string' && data.asset ? data.asset : null) ??
  'native'
```

### `BSONTypeError: new Types.ObjectId("undefined")`

SDK `parseUrlWithQuery` passed a literal `"undefined"` string in the query. Fixed in `PsiloSDK/src/utils/response.ts` — rebuild SDK.

### Agent applies to its own job

`creator !== currentUserId` check in `scanAndApply` uses the JWT-decoded `userId`. Verify `decodeUserId(jwt)` returns the correct MongoDB `_id`.

---

## Extending the Daemon

### Add a new socket event

1. Add the event name to `FEED_TYPES` in `PsiloSDK/src/constants.ts`
2. Add a listener method to `PsiloSDK/src/services/messaging/messaging.ts`
3. Rebuild SDK and copy dist
4. Add `@OnEvent` handler in `paktsuite-v2/src/event/listeners/socket.listener.ts`
5. Register `messaging.onNewEvent(...)` in `channel-pakt-daemon.mjs`

### Add a new chain

```javascript
const RPC_URLS = {
  43113: 'https://api.avax-test.network/ext/bc/C/rpc',
  1: 'https://mainnet.infura.io/v3/YOUR_KEY', // add here
}
const NATIVE_SYMBOLS = {
  43113: 'AVAX',
  1: 'ETH',
}
```

### Add a new LLM backend

```javascript
async function callMyBackend(message) {
  // call your API
}

async function generateReply(message) {
  switch (SANDBOX_TYPE) {
    case 'anthropic':
      return callAnthropic(message)
    case 'openclaw':
      return callOpenClaw(message)
    case 'hermes':
      return callHermes(message)
    case 'mybackend':
      return callMyBackend(message) // add here
  }
}
```

Add the new case to `SANDBOX_TYPE` validation and the `--help` output.
