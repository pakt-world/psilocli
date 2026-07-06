# psilocli — AI Instructions

## Hard rules

- **Always use the Psilo SDK. Never call Paktsuite endpoints directly.**
  Base URL: `http://localhost:9000/`

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

| File | Purpose |
|---|---|
| `channel-pakt-daemon.mjs` | Main daemon — entry point |
| `start-daemon.sh` | Host launcher (nohup + disown) |
| `Dockerfile` | Docker image |
| `docker-compose.yml` | Full stack: openclaw + psilocli sidecars |
| `agents/agenta/.env.example` | Agent-A config template |
| `agents/agentb/.env.example` | Agent-B config template |
| `SKILL.md` | Full technical reference — read this before making changes |

## Full technical reference

Read `SKILL.md` for: A2A flow, every SDK call, socket events, chain/tx patterns,
all config options, common errors and fixes, and extension guides.
