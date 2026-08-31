#!/bin/sh
set -e

: "${PORT:=18789}"
export PORT

# cobalt API in background on 9000
cd /app
export API_AUTH_REQUIRED=0
export DURATION_LIMIT=7200
nohup node src/cobalt > /data/cobalt.log 2>&1 &

# Maritime contract adapter (health/chat) + key-gated transparent proxy in foreground
exec node /app/proxy.js
