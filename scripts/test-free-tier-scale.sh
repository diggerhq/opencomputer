#!/bin/bash
# Test free tier scale-up enforcement: create a 4GB sandbox, then try scaling up.
# Currently the scale endpoints do NOT enforce plan limits — this script proves it.
# Usage: ./scripts/test-free-tier-scale.sh [BASE_URL] [API_KEY]

BASE_URL="${1:-https://app.opencomputer.dev}"
API_KEY="${2:-osb_074aaf51bd0dd98189afe64014b8a0645c823dafb904e90a9b870bc8929cdc3d}"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}PASS${NC} $1"; }
fail() { echo -e "${RED}FAIL${NC} $1"; }
info() { echo -e "${YELLOW}INFO${NC} $1"; }

API="$BASE_URL/api"
AUTH="-H X-API-Key:$API_KEY"
CLEANUP_IDS=()

cleanup() {
  for id in "${CLEANUP_IDS[@]}"; do
    curl -s -X DELETE "$API/sandboxes/$id" $AUTH > /dev/null 2>&1
    info "Cleaned up sandbox $id"
  done
}
trap cleanup EXIT

echo "================================================"
echo " Free Tier Scale-Up Enforcement Tests"
echo " Base URL: $BASE_URL"
echo "================================================"
echo ""

# --- Step 1: Create a 4GB/1vCPU sandbox (allowed on free tier)
info "Step 1: Create 4GB/1vCPU sandbox (should succeed)"
RESP=$(curl -s -w "\n%{http_code}" -X POST "$API/sandboxes" \
  $AUTH -H "Content-Type: application/json" \
  -d '{"templateID":"default","memoryMB":4096,"cpuCount":1}')
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
SB_ID=$(echo "$BODY" | grep -o '"sandboxID":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ "$CODE" = "200" ] || [ "$CODE" = "201" ]; then
  pass "Created sandbox: $SB_ID (HTTP $CODE)"
  CLEANUP_IDS+=("$SB_ID")
else
  fail "Expected 200/201, got HTTP $CODE: $BODY"
  echo "Cannot continue without a sandbox. Exiting."
  exit 1
fi
echo ""
sleep 2

# --- Test 2: Scale to 8GB via POST /scale (should be blocked with 402)
info "Test 2: Scale to 8GB via POST /sandboxes/$SB_ID/scale (should fail - 402)"
RESP=$(curl -s -w "\n%{http_code}" -X POST "$API/sandboxes/$SB_ID/scale" \
  $AUTH -H "Content-Type: application/json" \
  -d '{"memoryMB":8192}')
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')

if [ "$CODE" = "402" ]; then
  pass "Correctly blocked scale to 8GB (HTTP 402)"
else
  fail "Expected 402, got HTTP $CODE — free tier user was able to scale up! Body: $BODY"
fi
echo ""

# --- Test 3: Scale to 16GB via POST /scale (should be blocked with 402)
info "Test 3: Scale to 16GB via POST /sandboxes/$SB_ID/scale (should fail - 402)"
RESP=$(curl -s -w "\n%{http_code}" -X POST "$API/sandboxes/$SB_ID/scale" \
  $AUTH -H "Content-Type: application/json" \
  -d '{"memoryMB":16384}')
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')

if [ "$CODE" = "402" ]; then
  pass "Correctly blocked scale to 16GB (HTTP 402)"
else
  fail "Expected 402, got HTTP $CODE — free tier user was able to scale up! Body: $BODY"
fi
echo ""

# --- Test 4: Scale to 8GB via PUT /limits (should be blocked with 402)
info "Test 4: Scale to 8GB via PUT /sandboxes/$SB_ID/limits (should fail - 402)"
RESP=$(curl -s -w "\n%{http_code}" -X PUT "$API/sandboxes/$SB_ID/limits" \
  $AUTH -H "Content-Type: application/json" \
  -d '{"memoryMB":8192}')
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')

if [ "$CODE" = "402" ]; then
  pass "Correctly blocked limits to 8GB (HTTP 402)"
else
  fail "Expected 402, got HTTP $CODE — free tier user was able to set limits! Body: $BODY"
fi
echo ""

# --- Test 5: Re-scale to 4GB (should succeed — staying within free tier)
info "Test 5: Scale to 4GB via POST /sandboxes/$SB_ID/scale (should succeed - same tier)"
RESP=$(curl -s -w "\n%{http_code}" -X POST "$API/sandboxes/$SB_ID/scale" \
  $AUTH -H "Content-Type: application/json" \
  -d '{"memoryMB":4096}')
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')

if [ "$CODE" = "200" ]; then
  pass "Allowed scale to 4GB (HTTP 200) — within free tier"
else
  fail "Expected 200, got HTTP $CODE: $BODY"
fi
echo ""

echo "================================================"
echo " Tests complete"
echo "================================================"
