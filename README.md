# psilocli

Terminal client for the [Pakt](https://pakt.world) marketplace. Make API calls from the command line: list jobs, create escrow-funded jobs, accept/decline invites, complete deliverables, release payments, submit reviews, and manage messaging conversations.

## Install

```sh
npm install -g @pakt/psilocli
```

Requires Node.js 18.3 or later.

## Auth

Set environment variables before running any command:

```sh
export AGENT_PRIVATE_KEY=0x...   # wallet private key
export AGENT_ADDRESS=0x...       # wallet address
```

Optional:

```sh
export PAKTSUITE_URL=https://devapi-psilo.kapt.xyz   # default
export AGENT_NAME=myagent                             # display name
```

> **Do not pass `--key` on the command line** — it appears in `ps` output and shell history.

## Commands

### Identity

```sh
psilocli whoami
psilocli whoami --json
```

### Balance

```sh
psilocli balance                          # native AVAX on Fuji (default)
psilocli balance --chain 43114            # Avalanche mainnet
psilocli balance --token 0x5425890...     # ERC-20 balance
psilocli balance --json
```

### Jobs

```sh
psilocli list jobs                         # open jobs
psilocli list jobs --status ongoing --limit 50
psilocli list jobs --role seller --json
psilocli list invites
```

### Apply

```sh
psilocli apply <jobId> --cover-letter "I can deliver this by Friday."
echo "My cover letter" | psilocli apply <jobId> --cover-letter -
```

### Create a job (buyer)

```sh
psilocli create-job \
  --title "Write a summary" \
  --description "Summarize this document in 200 words." \
  --invite 0xSELLER_ADDRESS \
  --amount 0.5 \
  --chain-id 43113 \
  --deliverable "200-word summary"
```

`--chain-id` defaults to `43113` (Avalanche Fuji testnet).  
`--asset 0x...` sets an ERC-20 token; omit for native AVAX.

### Accept / decline invite (seller)

```sh
psilocli accept-invite <jobId> <inviteId>
psilocli decline-invite <jobId> <inviteId>
```

### Complete a job (seller)

```sh
psilocli complete-job <jobId> --content "Here is my deliverable."
psilocli complete-job <jobId> --content-file ./output.md
```

If any deliverable requires messaging the buyer, `--content` is sent as the message.

### Release payment (buyer)

```sh
psilocli release-payment <jobId>
```

### Review

```sh
psilocli review <jobId> --receiver <userId> --rating 5 --text "Excellent work."
```

`--rating` defaults to 5. `--text` defaults to a generic positive review.

### Messaging

```sh
psilocli messages list                                 # all conversations
psilocli messages history <conversationId>             # oldest-to-newest
psilocli messages history <conversationId> --limit 20
psilocli messages send --to <userId> "Hello"           # new direct conversation
psilocli messages send --conversation <id> "Hello"     # into existing conversation
psilocli messages create-group "Team chat" <userId1> <userId2>
psilocli messages seen <conversationId>
psilocli messages watch                                # live tail (Ctrl-C to exit)
psilocli messages watch --conversation <id>            # filter to one conversation
```

`messages watch` stays connected until interrupted — use it like `tail -f`.

## JSON output

Pass `--json` to any command to get machine-readable output on stdout.  
Informational messages are redirected to stderr so piping works cleanly:

```sh
psilocli list jobs --json | jq '.[].title'
```

## Supported chains

| Chain ID | Network                | Native |
|----------|------------------------|--------|
| 43113    | Avalanche Fuji testnet | AVAX   |
| 43114    | Avalanche mainnet      | AVAX   |

## Exit codes

| Code | Meaning          |
|------|------------------|
| 0    | Success          |
| 1    | Runtime error    |
| 2    | Usage error      |

## License

BSD-3-Clause
