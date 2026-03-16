#!/usr/bin/env bash
# rest-api-watchdog.sh — Detects when OpenClaw REST API endpoints are missing
# Run via cron every 5 minutes or after OpenClaw updates
#
# Exit codes:
#   0 = REST API healthy
#   1 = REST API missing (OpenClaw was likely updated)
#   2 = Gateway not running at all

set -euo pipefail

GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
GATEWAY_HOST="127.0.0.1"
CONFIG_FILE="${HOME}/.openclaw/openclaw.json"
ALERT_FILE="/tmp/openclaw-rest-api-alert"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Get token from config
get_token() {
  if command -v python3 &>/dev/null && [ -f "$CONFIG_FILE" ]; then
    python3 -c "import json; print(json.load(open('$CONFIG_FILE')).get('gateway',{}).get('auth',{}).get('token',''))" 2>/dev/null || echo ""
  else
    echo ""
  fi
}

# Check if gateway is running
check_gateway() {
  curl -s -o /dev/null -w "%{http_code}" --connect-timeout 2 "http://${GATEWAY_HOST}:${GATEWAY_PORT}/health" 2>/dev/null || echo "000"
}

# Check REST API
check_rest_api() {
  local token
  token=$(get_token)
  local auth_header=""
  [ -n "$token" ] && auth_header="Authorization: Bearer $token"

  local status
  if [ -n "$auth_header" ]; then
    status=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 2 \
      -H "$auth_header" \
      "http://${GATEWAY_HOST}:${GATEWAY_PORT}/api/v1/agents" 2>/dev/null || echo "000")
  else
    status=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 2 \
      "http://${GATEWAY_HOST}:${GATEWAY_PORT}/api/v1/agents" 2>/dev/null || echo "000")
  fi
  echo "$status"
}

# Main
main() {
  local gateway_status
  gateway_status=$(check_gateway)

  if [ "$gateway_status" = "000" ]; then
    echo -e "${RED}⛔ Gateway not running on port ${GATEWAY_PORT}${NC}"
    exit 2
  fi

  local rest_status
  rest_status=$(check_rest_api)

  if [ "$rest_status" = "200" ]; then
    # Healthy — clear any previous alert
    [ -f "$ALERT_FILE" ] && rm -f "$ALERT_FILE"
    if [ "${1:-}" = "--verbose" ]; then
      echo -e "${GREEN}✅ REST API healthy (${rest_status})${NC}"
    fi
    exit 0
  fi

  # REST API missing or broken
  echo -e "${RED}🚨 REST API MISSING — got HTTP ${rest_status} from /api/v1/agents${NC}"
  echo ""
  echo -e "${YELLOW}OpenClaw was likely updated and overwrote the REST API patch.${NC}"
  echo ""
  echo "Quick fix:"
  echo "  cd ~/openclaw"
  echo "  git fetch fork feat/rest-api-endpoints"
  echo "  git checkout fork/feat/rest-api-endpoints -- src/gateway/server-rest-api.ts src/gateway/server-http.ts"
  echo "  pnpm build"
  echo "  openclaw gateway stop && sleep 3 && openclaw gateway start"
  echo ""
  echo "Or run the auto-fix script:"
  echo "  ~/cortex-ide/scripts/rest-api-patch.sh"
  echo ""

  # Write alert file for other tools to detect
  echo "REST_API_MISSING $(date -u +%Y-%m-%dT%H:%M:%SZ) http_status=${rest_status}" > "$ALERT_FILE"

  exit 1
}

main "$@"
