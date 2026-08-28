#!/usr/bin/env bash
# Waits for hydration to finish, then rebuilds the catalog and re-verifies.
# Safe to run while stage 02 is still fetching.
set -uo pipefail
cd "$(dirname "$0")/.."

echo "waiting for hydrate to finish…"
while pgrep -f "02-hydrate.js" > /dev/null; do sleep 30; done
echo "hydrate done"

npm run build:catalog || { echo "catalog build FAILED"; exit 1; }

pkill -f "server/index.js" || true
sleep 1
nohup node server/index.js > data/server.log 2>&1 &
sleep 3

node scripts/smoke.js
echo "BUILD COMPLETE"
