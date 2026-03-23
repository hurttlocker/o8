#!/bin/bash
# Cortex IDE server launcher — started by Tauri as a sidecar
cd "$(dirname "$0")"
export PORT=3001
export HOSTNAME=127.0.0.1
export NODE_ENV=production
exec node server.js
