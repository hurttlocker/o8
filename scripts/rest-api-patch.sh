#!/usr/bin/env bash
# rest-api-patch.sh — Re-applies the REST API patch to OpenClaw after an update
#
# Source: https://github.com/hurttlocker/openclaw/tree/feat/rest-api-endpoints
# PR: https://github.com/openclaw/openclaw/pull/47863
#
# Usage:
#   ./rest-api-patch.sh           # Auto-detect OpenClaw dir
#   ./rest-api-patch.sh ~/openclaw  # Explicit path

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

OPENCLAW_DIR="${1:-${HOME}/openclaw}"
GATEWAY_SRC="${OPENCLAW_DIR}/src/gateway"
FORK_REMOTE="https://github.com/hurttlocker/openclaw.git"
FORK_BRANCH="feat/rest-api-endpoints"

echo -e "${CYAN}═══ OpenClaw REST API Patch ═══${NC}"
echo ""

# Validate
if [ ! -f "${GATEWAY_SRC}/server-http.ts" ]; then
  echo -e "${RED}Error: ${GATEWAY_SRC}/server-http.ts not found${NC}"
  echo "Pass the correct OpenClaw directory: $0 /path/to/openclaw"
  exit 1
fi

# Check if already patched
if grep -q "handleRestApiRequest" "${GATEWAY_SRC}/server-http.ts" 2>/dev/null; then
  echo -e "${GREEN}✅ REST API patch already applied in source${NC}"

  # Check if it's also in the bundle
  if grep -q "handleRestApiRequest" "${OPENCLAW_DIR}"/dist/gateway-cli-*.js 2>/dev/null; then
    echo -e "${GREEN}✅ REST API is in the compiled bundle${NC}"
    echo "Nothing to do."
    exit 0
  else
    echo -e "${YELLOW}⚠️  Source patched but bundle is stale — rebuilding...${NC}"
  fi
else
  echo -e "${YELLOW}Applying REST API patch...${NC}"
  echo ""

  # Method 1: Try git checkout from fork
  cd "$OPENCLAW_DIR"
  if git remote get-url fork &>/dev/null 2>&1; then
    echo "Fetching from fork remote..."
    git fetch fork "$FORK_BRANCH" 2>/dev/null || true
    if git rev-parse "fork/${FORK_BRANCH}" &>/dev/null 2>&1; then
      git checkout "fork/${FORK_BRANCH}" -- src/gateway/server-rest-api.ts src/gateway/server-http.ts
      echo -e "${GREEN}✅ Patched from fork${NC}"
    else
      echo -e "${YELLOW}Fork branch not available, using embedded patch...${NC}"
      apply_embedded_patch
    fi
  else
    # Add fork remote
    echo "Adding fork remote..."
    git remote add fork "$FORK_REMOTE" 2>/dev/null || true
    git fetch fork "$FORK_BRANCH" 2>/dev/null || true
    if git rev-parse "fork/${FORK_BRANCH}" &>/dev/null 2>&1; then
      git checkout "fork/${FORK_BRANCH}" -- src/gateway/server-rest-api.ts src/gateway/server-http.ts
      echo -e "${GREEN}✅ Patched from fork${NC}"
    else
      echo -e "${YELLOW}Cannot reach fork, using embedded patch...${NC}"
      apply_embedded_patch
    fi
  fi
fi

# Build
echo ""
echo -e "${CYAN}Building OpenClaw...${NC}"
cd "$OPENCLAW_DIR"
pnpm build 2>&1 | tail -5

# Verify
if grep -q "handleRestApiRequest" "${OPENCLAW_DIR}"/dist/gateway-cli-*.js 2>/dev/null; then
  echo ""
  echo -e "${GREEN}✅ REST API in bundle${NC}"
else
  echo ""
  echo -e "${RED}❌ REST API NOT in bundle — build may have failed${NC}"
  exit 1
fi

# Restart
echo ""
echo -e "${CYAN}Restarting gateway...${NC}"
openclaw gateway stop 2>/dev/null || true
sleep 3
openclaw gateway start 2>&1 | tail -3
sleep 5

# Test
TOKEN=$(python3 -c "import json; print(json.load(open('${HOME}/.openclaw/openclaw.json')).get('gateway',{}).get('auth',{}).get('token',''))" 2>/dev/null || echo "")
if [ -n "$TOKEN" ]; then
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TOKEN" http://127.0.0.1:18789/api/v1/agents 2>/dev/null || echo "000")
else
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:18789/api/v1/agents 2>/dev/null || echo "000")
fi

if [ "$STATUS" = "200" ]; then
  echo ""
  echo -e "${GREEN}═══ REST API LIVE ═══${NC}"
  echo -e "${GREEN}GET /api/v1/agents → 200${NC}"
  rm -f /tmp/openclaw-rest-api-alert
else
  echo ""
  echo -e "${RED}═══ REST API FAILED (HTTP ${STATUS}) ═══${NC}"
  echo "Check gateway logs: tail -30 /tmp/openclaw/openclaw-\$(date +%Y-%m-%d).log"
  exit 1
fi

# Embedded patch function (fallback when git fork is unreachable)
apply_embedded_patch() {
  # server-rest-api.ts is self-contained — create it from the canonical version
  # stored at: https://github.com/hurttlocker/openclaw/blob/feat/rest-api-endpoints/src/gateway/server-rest-api.ts
  echo -e "${RED}ERROR: Git fork unreachable and no embedded patch available.${NC}"
  echo ""
  echo "Manual fix:"
  echo "  1. Copy server-rest-api.ts from another machine with the patch"
  echo "  2. Or download from: https://github.com/hurttlocker/openclaw/blob/feat/rest-api-endpoints/src/gateway/server-rest-api.ts"
  echo "  3. Add import + stage to server-http.ts (see PR #47863)"
  exit 1
}
