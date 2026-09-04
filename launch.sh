#!/usr/bin/env bash
# Giant Money — put the site online from this Mac, right now.
#
#   ./launch.sh
#
# Starts the server if it is not already up, then opens a public HTTPS tunnel and
# prints the link you can send to anyone.
#
# What this is and is not:
#   · it IS a real public URL, served by this machine
#   · it stays up only while this window is open and the Mac is awake
#   · the URL changes each time you run it
# For a permanent address that survives your laptop closing, see DEPLOY.md.
set -uo pipefail

PORT="${PORT:-4600}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

say()  { printf '\n\033[1;32m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m  !\033[0m %s\n' "$1"; }

# ── 1. dependencies ─────────────────────────────────────────────────────────
if [[ ! -d node_modules ]]; then
  say "Installing dependencies (one time, compiles better-sqlite3)"
  npm ci || npm install
fi

# ── 2. server ───────────────────────────────────────────────────────────────
if curl -fsS --max-time 3 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
  say "Server already running on port $PORT"
else
  say "Starting the server on port $PORT"
  PORT="$PORT" node src/index.js > /tmp/giant-money.log 2>&1 &
  SERVER_PID=$!
  # give it a moment, then confirm rather than assume
  for _ in $(seq 1 20); do
    sleep 1
    curl -fsS --max-time 3 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
  done
  if ! curl -fsS --max-time 3 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    warn "The server did not come up. Last lines of /tmp/giant-money.log:"
    tail -15 /tmp/giant-money.log
    exit 1
  fi
  echo "    started (pid $SERVER_PID), logs in /tmp/giant-money.log"
fi

# keep the Mac awake for as long as this script runs, otherwise sleeping the lid
# silently takes the site down
if command -v caffeinate >/dev/null; then
  caffeinate -dimsu -w $$ &
  echo "    display and sleep held off while this runs"
fi

# ── 3. public tunnel ────────────────────────────────────────────────────────
say "Opening a public HTTPS tunnel"
echo "    Your Mac is the server. Anyone with the link can open the site."
echo "    Press Ctrl+C to take it offline."
echo

if command -v cloudflared >/dev/null; then
  # cloudflared prints its own https://…trycloudflare.com URL
  exec cloudflared tunnel --url "http://localhost:$PORT"
else
  echo "    Using localhost.run over ssh (nothing to install)."
  echo "    Look for the https://…lhr.life address in the output below —"
  echo "    that is the link to share."
  echo
  exec ssh -o StrictHostKeyChecking=accept-new \
           -o ServerAliveInterval=30 \
           -o ExitOnForwardFailure=yes \
           -R "80:localhost:$PORT" nokey@localhost.run
fi
