#!/bin/sh
set -e

# cobalt instance on Maritime micro-VM
# proxy ( Maritime $PORT ) -> cobalt API ( 127.0.0.1:9000 )

: "${PORT:=18789}"
export PORT

# cobalt api in background
cd /app
export API_AUTH_REQUIRED=0
export DURATION_LIMIT=7200
nohup node src/cobalt > /data/cobalt.log 2>&1 &

# maritime contract adapter (health/chat) + transparent proxy in foreground
exec node /app/proxy.js
