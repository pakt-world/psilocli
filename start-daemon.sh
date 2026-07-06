#!/usr/bin/env bash
# Starts psilocli daemons on the host (no Docker required).
# Uses nohup + disown so processes survive terminal/session closes.
#
# ── Workflow ───────────────────────────────────────────────────────────────
#
#   1. One-time setup per agent — copy the template and fill in real keys:
#
#        cp agents/agenta/.env.example agents/agenta/.env
#        cp agents/agentb/.env.example agents/agentb/.env
#        # edit both .env files: AGENT_PRIVATE_KEY, AGENT_ADDRESS, ANTHROPIC_API_KEY
#
#   2. Start / stop / status:
#
#        ./start-daemon.sh both start
#        ./start-daemon.sh both status
#        ./start-daemon.sh both stop
#
#        ./start-daemon.sh agent-a start
#        ./start-daemon.sh agent-b stop
#
#   3. Follow live logs:
#
#        tail -f /tmp/daemon-agent-a.log /tmp/daemon-agent-b.log
#
#   4. Kill everything at once:
#
#        pkill -f "channel-pakt-daemon"
#
#   5. Verify all stopped:
#
#        pgrep -fl "channel-pakt-daemon"
#
# ── Notes ──────────────────────────────────────────────────────────────────
#
#   - Credentials are read from ../agents/agenta/.env and ../agents/agentb/.env.
#     Never hardcode keys in this script.
#
#   - To run in Docker instead, use docker-compose-psilo-agents.yml in the
#     repo root. This script is for host-only (no Docker) development.
#
# ──────────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$SCRIPT_DIR"
DAEMON_DIR="$SCRIPT_DIR"
AGENTS_DIR="$SCRIPT_DIR/agents"

ENV_FILE_A="$AGENTS_DIR/agenta/.env"
ENV_FILE_B="$AGENTS_DIR/agentb/.env"

# ── Dependency check ───────────────────────────────────────────────────────

ensure_daemon_deps() {
  if [[ ! -d "$DAEMON_DIR/node_modules" ]]; then
    echo "[daemon] node_modules missing — running npm install in $DAEMON_DIR"
    npm install --prefix "$DAEMON_DIR" --silent
  fi
}

# ── Agent lifecycle ────────────────────────────────────────────────────────

start_agent() {
  local name="$1"
  local env_file="$2"
  local logfile="/tmp/daemon-${name}.log"

  if [[ ! -f "$env_file" ]]; then
    echo "[${name}] ERROR: env file not found: $env_file"
    echo "[${name}]   Copy the template:  cp ${env_file}.example ${env_file}"
    echo "[${name}]   Then fill in AGENT_PRIVATE_KEY and AGENT_ADDRESS."
    return 1
  fi

  if pgrep -f "AGENT_NAME=${name}" > /dev/null 2>&1; then
    echo "[${name}] already running — PID $(pgrep -f "AGENT_NAME=${name}")"
    return
  fi

  # Load env file: skip blank lines and comments, export everything.
  set -o allexport
  # shellcheck disable=SC1090
  source <(grep -v '^\s*#' "$env_file" | grep -v '^\s*$')
  set +o allexport

  nohup env "AGENT_NAME=${AGENT_NAME:-$name}" \
    node "$DAEMON_DIR/channel-pakt-daemon.mjs" \
    > "$logfile" 2>&1 &
  disown $!
  echo "[${name}] started — PID $! — log: $logfile"
}

stop_agent() {
  local name="$1"
  if pkill -f "AGENT_NAME=${name}" 2>/dev/null; then
    echo "[${name}] stopped"
  else
    echo "[${name}] not running"
  fi
}

status_agent() {
  local name="$1"
  local pid
  pid=$(pgrep -f "AGENT_NAME=${name}" 2>/dev/null || true)
  if [[ -n "$pid" ]]; then
    echo "[${name}] RUNNING — PID $pid"
  else
    echo "[${name}] STOPPED"
  fi
}

# ── Main ───────────────────────────────────────────────────────────────────

TARGET="${1:-both}"
ACTION="${2:-start}"

if [[ "$ACTION" == "start" ]]; then
  ensure_daemon_deps
fi

run_for() {
  local name="$1"
  local env_file="$2"
  case "$ACTION" in
    start)  start_agent  "$name" "$env_file" ;;
    stop)   stop_agent   "$name" ;;
    status) status_agent "$name" ;;
    *) echo "Unknown action: $ACTION — use start | stop | status"; exit 1 ;;
  esac
}

case "$TARGET" in
  agent-a) run_for agent-a "$ENV_FILE_A" ;;
  agent-b) run_for agent-b "$ENV_FILE_B" ;;
  both)
    run_for agent-a "$ENV_FILE_A"
    run_for agent-b "$ENV_FILE_B"
    ;;
  *)
    echo "Usage: $0 [agent-a|agent-b|both] [start|stop|status]"
    exit 1
    ;;
esac
