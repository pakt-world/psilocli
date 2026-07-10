# psilocli — AI Instructions

## Hard rules

- **Always use the Psilo SDK. Never call Paktsuite endpoints directly.**
  Base URL: `https://devapi-psilo.kapt.xyz/`
  (Known exception: the `by-wallet` account lookup in
  `src/commands/create-job.js` — the SDK has no method for it yet.)

- **All imports go at the top of every file. Never use inline `import()` expressions.**

## SDK rebuild

After editing `psilo-sdk/src/`, rebuild and copy BOTH dist files or the ESM
entry will silently run stale code:

```sh
cd ../psilo-sdk   # or wherever the SDK lives
npm run build
cp dist/main.js     <repo>/node_modules/@pakt/psilo/dist/main.js
cp dist/main.js.map <repo>/node_modules/@pakt/psilo/dist/main.js.map
cp dist/main.mjs     <repo>/node_modules/@pakt/psilo/dist/main.mjs
cp dist/main.mjs.map <repo>/node_modules/@pakt/psilo/dist/main.mjs.map
```

Node ESM resolves `dist/main.mjs` — forgetting it means `main.js` changes take
effect but any ESM import picks up the old build.

## Key files

| File                  | Purpose                                                       |
| --------------------- | ------------------------------------------------------------- |
| `bin/psilocli.mjs`    | Entry point — help/version, verb router, send-message alias   |
| `src/config.js`       | Global flags + env fallbacks, strict parseArgs wrapper        |
| `src/client.js`       | `cliInit()` (SDK init + web3 login), `sdkOk()`, JWT decode    |
| `src/chains.js`       | RPC URLs, `signAndBroadcast()`, ERC-20 balance reader         |
| `src/messaging.js`    | `withMessaging()` socket lifecycle, timeouts, flush delay     |
| `src/output.js`       | stdout/stderr discipline: `out()`, `print()`, `note()`, table |
| `src/commands/*.js`   | One module per subcommand                                     |
| `SKILL.md`            | Technical reference — read this before making changes         |

## Conventions

- stdout carries command output only (tables or `--json`); progress and
  diagnostics go to stderr via `note()`. Exit codes: 0 success, 1 error,
  2 usage error.
- Every command parses its own argv with `parseCommand()` (strict) and
  resolves auth via `resolveConfig()`.
- The daemon that used to live here was removed in 0.1.0 — do not add
  long-running or LLM-driven behavior to this package (`messages watch`
  is the only command that stays connected, and only until Ctrl-C).
