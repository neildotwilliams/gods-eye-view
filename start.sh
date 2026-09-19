#!/usr/bin/env bash
# Start the God's Eye View dev server on this laptop.
#
# The system Node is 20; the project needs >=24.14 <25 or 26.x. This prefers a
# user-space Node 24 under ~/.local/opt and falls back to whatever `node` is on
# PATH if that is already a supported version. Installs dependencies (via sfw)
# only when node_modules is missing. Extra arguments are passed to Vite, and
# HOST/PORT are honoured as in the upstream launcher (default localhost:4173).
set -euo pipefail

cd "$(dirname "$0")"

NODE_DIR="${GEV_NODE_DIR:-$HOME/.local/opt/node-v24.21.0-linux-x64}"
if [[ -x "$NODE_DIR/bin/node" ]]; then
  export PATH="$NODE_DIR/bin:$PATH"
fi

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [[ "$major" == 24 || "$major" == 26 ]]
}

if ! node_ok; then
  echo "error: need Node 24.14+ or 26.x (found: $(node -v 2>/dev/null || echo none))." >&2
  echo "Install one under ~/.local/opt or set GEV_NODE_DIR to its directory." >&2
  exit 1
fi

if [[ ! -d node_modules ]]; then
  if ! command -v sfw >/dev/null 2>&1; then
    echo "SECURITY CRITICAL: sfw is not installed. Install: npm i -g sfw" >&2
    exit 1
  fi
  echo "Installing locked dependencies via sfw..."
  sfw npm ci
fi

PORT="${PORT:-4173}"
if curl -s -o /dev/null --max-time 2 "http://localhost:$PORT/"; then
  echo "Something is already serving http://localhost:$PORT/ (stop it with: fuser -k $PORT/tcp)." >&2
  exit 1
fi

echo "Node $(node -v) - starting on http://localhost:$PORT/"
exec npm run dev -- "$@"
