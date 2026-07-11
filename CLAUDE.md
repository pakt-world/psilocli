# psilocli — AI Instructions

## Hard rules

- **Always use the Psilo SDK. Never call Paktsuite endpoints directly.**
  Base URL: `https://devapi-psilo.kapt.xyz/`

- **All imports go at the top of every file. Never use inline `import()` expressions.**

## SDK rebuild

After editing `PsiloSDK/src/`, rebuild and copy BOTH dist files or the ESM
entry will silently run stale code:

```sh
cd ../PsiloSDK   # or wherever PsiloSDK lives
npm run build
cp dist/main.js     <repo>/node_modules/@pakt/psilo/dist/main.js
cp dist/main.js.map <repo>/node_modules/@pakt/psilo/dist/main.js.map
cp dist/main.mjs     <repo>/node_modules/@pakt/psilo/dist/main.mjs
cp dist/main.mjs.map <repo>/node_modules/@pakt/psilo/dist/main.mjs.map
```

Node ESM resolves `dist/main.mjs` — forgetting it means `main.js` changes take
effect but any ESM import picks up the old build.

## Key files

| File                            | Purpose                                              |
| ------------------------------- | ---------------------------------------------------- |
| `bin/psilocli.mjs`              | Entry point — global flags, --help/--version, router |
| `src/config.js`                 | Flag + env parsing; validates required creds         |
| `src/client.js`                 | `cliInit()`, `sdkOk()`, `decodeUserId()`             |
| `src/chains.js`                 | RPC URLs, `signAndBroadcast()`, `readTokenBalance()` |
| `src/output.js`                 | `out()`, `fail()`, `cliTable()`, `configureJsonMode()` |
| `src/messaging.js`              | `withMessaging()` — connect/run/disconnect lifecycle |
| `src/commands/whoami.js`        | `whoami` command                                     |
| `src/commands/balance.js`       | `balance` command                                    |
| `src/commands/list.js`          | `list jobs` / `list invites`                         |
| `src/commands/apply.js`         | `apply <jobId>` (--cover-letter required)            |
| `src/commands/create-job.js`    | `create-job` — escrow deposit + invite flow          |
| `src/commands/accept-invite.js` | `accept-invite <jobId> <inviteId>`                   |
| `src/commands/decline-invite.js`| `decline-invite <jobId> <inviteId>`                  |
| `src/commands/complete-job.js`  | `complete-job` — user content replaces LLM           |
| `src/commands/release-payment.js`| `release-payment <jobId>`                           |
| `src/commands/review.js`        | `review <jobId>`                                     |
| `src/commands/messages.js`      | `messages` group — list/history/send/watch/…         |
| `SKILL.md`                      | CLI technical reference — read before making changes |

## Full technical reference

Read `SKILL.md` for: every SDK call, tx-signing pattern, config options,
common errors and fixes.
