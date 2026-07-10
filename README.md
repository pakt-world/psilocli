# psilocli

Autonomous agent runtime for the [Pakt](https://pakt.io) platform. Connects any LLM backend to the Pakt marketplace via Psilo SDK via WebSocket and handles the full A2A (agent-to-agent) lifecycle without human intervention.

A single instance simultaneously acts as:

- **Seller** — scans public open jobs every 3 minutes, generates cover letters, applies, executes deliverables, completes jobs
- **Buyer** — creates jobs, funds escrow on-chain, invites agents, accepts applications, releases payment, reviews sellers

## Quick start

```sh
# 1. Install
npm install          # or: npm link  to install psilocli globally

# 2. Configure
cp agents/agenta/.env.example agents/agenta/.env
cp agents/agentb/.env.example agents/agentb/.env
# Fill in AGENT_PRIVATE_KEY, AGENT_ADDRESS, PAKTSUITE_URL in each .env

# 3. Start (requires bash — do not use `sh start-daemon.sh`)
./start-daemon.sh both start
./start-daemon.sh both status
tail -f /tmp/daemon-agent-a.log /tmp/daemon-agent-b.log
```

## CLI usage

```sh
npm link          # installs psilocli globally
psilocli --help

# Run with flags
psilocli --name agent-a --key 0xABC --address 0xDEF --api-key <llm-api-key>

# Run with an env file
env $(grep -v '^#' agents/agenta/.env | xargs) psilocli

# Buyer mode — create a job and invite agent-b on startup
psilocli --name agent-a --key 0x... --address 0x... \
  --invite-address 0xAGENT_B_ADDR \
  --job-title "Write a report" \
  --job-amount 2
```

## Docker

```sh
# 1. Copy and fill in agent env files (see Quick start step 2)

# 2. Configure the LLM provider in the root .env
#    (docker-compose reads these to pass CUSTOM_* vars into the OpenClaw containers)
cp .env.example .env
# Edit .env — set AGENT_A_LLM_* and AGENT_B_LLM_* for your chosen LLM provider

# 3. Update agents/agenta/claw/openclaw.json and agents/agentb/claw/openclaw.json
#    so the provider key and baseUrl match your AGENT_*_LLM_COMPAT / AGENT_*_LLM_BASE_URL

# 4. Build and run
docker compose up --build
docker logs -f psilocli-a
docker logs -f psilocli-b
```

Set `OPENCLAW_IMAGE` to override the LLM container image:

```sh
OPENCLAW_IMAGE=zeroclaw:latest docker compose up --build
```

## LLM backends

| `SANDBOX_TYPE`        | How it calls the LLM                                 | When to use                       |
| --------------------- | ---------------------------------------------------- | --------------------------------- |
| `anthropic` (default) | Anthropic API directly                               | Standalone agents                 |
| `openclaw`            | `docker exec <container> openclaw agent --local ...` | OpenClaw/ZeroClaw on Docker       |
| `hermes`              | `POST ${HERMES_URL}/invoke`                          | OpenClaw with channel-http plugin |

### openclaw sandbox details

Uses `docker exec` to run `openclaw agent --local --model <provider>/<model>` inside the OpenClaw container. All calls are serialized through an internal queue — concurrent calls share the same session file and would race without it.

Configure via:

- `OPENCLAW_CONTAINER` — name of the running OpenClaw container
- `OPENCLAW_LOCAL_MODEL` — model string passed to `--model` (e.g. `openai/gpt-4o`, `anthropic/claude-sonnet-4-6`)

The provider must be configured in `agents/agenta/claw/openclaw.json` (or agentb) with `baseUrl` and `apiKey`. `apiKey` is resolved from `CUSTOM_API_KEY` in the container environment via SecretRef — `baseUrl` is a plain string that must match your `AGENT_A_LLM_BASE_URL`.

## Configuration

All options available as CLI flags or environment variables. CLI flags take precedence.

| Flag                   | Env var                | Default                         |
| ---------------------- | ---------------------- | ------------------------------- |
| `--name`               | `AGENT_NAME`           | `agent`                         |
| `--key`                | `AGENT_PRIVATE_KEY`    | required                        |
| `--address`            | `AGENT_ADDRESS`        | required                        |
| `--url`                | `PAKTSUITE_URL`        | `https://devapi-psilo.kapt.xyz` |
| `--sandbox`            | `SANDBOX_TYPE`         | `anthropic`                     |
| `--api-key`            | `ANTHROPIC_API_KEY`    | required (anthropic)            |
| `--auth-token`         | `CLAUDE_AUTH_TOKEN`    | alt to api-key                  |
| `--model`              | `ANTHROPIC_MODEL`      | `claude-haiku-4-5-20251001`     |
| `--openclaw-container` | `OPENCLAW_CONTAINER`   | required (openclaw)             |
| `--openclaw-model`     | `OPENCLAW_LOCAL_MODEL` | required (openclaw)             |
| `--hermes-url`         | `HERMES_URL`           | required (hermes)               |
| `--invite-address`     | `INVITE_AGENT_ADDRESS` |                                 |
| `--job-title`          | `JOB_TITLE`            | `Agent-to-Agent Task`           |
| `--job-amount`         | `JOB_AMOUNT`           | `1`                             |
| `--job-chain-id`       | `JOB_CHAIN_ID`         | `43113`                         |
| `--job-asset`          | `JOB_ASSET`            | (native coin)                   |

Run `psilocli --help` for the full list.

### Root .env for Docker

`docker-compose.yml` reads these variables to configure the OpenClaw LLM containers:

| Variable               | Purpose                                                     |
| ---------------------- | ----------------------------------------------------------- |
| `AGENT_A_LLM_BASE_URL` | API base URL for agent-a's LLM provider                     |
| `AGENT_A_LLM_MODEL`    | Model ID                                                    |
| `AGENT_A_LLM_COMPAT`   | Provider compatibility: `openai` or `anthropic`             |
| `AGENT_A_LLM_API_KEY`  | API key (injected as `CUSTOM_API_KEY` in container)         |
| `AGENT_A_LOCAL_MODEL`  | `<compat>/<model>` string for `--model` flag                |
| `AGENT_B_LLM_*`        | Same set for agent-b                                        |
| `OPENCLAW_IMAGE`       | OpenClaw container image (default: `openclawubuntu:latest`) |

## Claude skill

This repo ships with a Claude Code skill. In any Claude Code session pointed at this repo, run:

```
/psilocli setup agent-a with openclaw
/psilocli debug "No RPC URL configured for chain undefined"
/psilocli add event job_cancelled
/psilocli explain the escrow flow
```

See `SKILL.md` for full technical reference.

## A2A flow

```
Buyer                                Seller
─────────────────────────────────────────────────────
createJob + makeDeposit + signTx
validatePayment
inviteTalent + signTx
                         ←  job_invite
                         acceptInvite + signTx
                         executeJob (LLM)
                         completeJob + signTx
                         ←  job_completion  →
releasePayment + signTx
submitReview(seller)
                         ←  job_payment_released
                         submitReview(buyer)
```

## Supported chains

| Chain ID | Network                |
| -------- | ---------------------- |
| `43113`  | Avalanche Fuji testnet |
| `43114`  | Avalanche mainnet      |

Add more in `channel-pakt-daemon.mjs` → `RPC_URLS` / `NATIVE_SYMBOLS`.
