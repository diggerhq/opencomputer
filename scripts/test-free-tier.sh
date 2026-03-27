#!/bin/bash
# Test free tier enforcement: 5 concurrent sandboxes, 4GB/1vCPU only
# Usage: ./scripts/test-free-tier.sh [BASE_URL] [API_KEY]

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

echo "================================================"
echo " Free Tier Enforcement Tests"
echo " Base URL: $BASE_URL"
echo "================================================"
echo ""

# --- Test 1: Create a 4GB sandbox (should succeed on free tier)
info "Test 1: Create 4GB/1vCPU sandbox (should succeed)"
RESP=$(curl -s -w "\n%{http_code}" -X POST "$API/sandboxes" \
  $AUTH -H "Content-Type: application/json" \
  -d '{"templateID":"default","memoryMB":4096,"cpuCount":1}')
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
SB1_ID=$(echo "$BODY" | grep -o '"sandboxID":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ "$CODE" = "200" ] || [ "$CODE" = "201" ]; then
  pass "Created sandbox: $SB1_ID (HTTP $CODE)"
else
  fail "Expected 200/201, got HTTP $CODE: $BODY"
fi
echo ""

# --- Test 2: Try creating a second sandbox (should fail - concurrency limit)
info "Test 2: Create second sandbox (should fail - concurrency limit)"
sleep 2
RESP=$(curl -s -w "\n%{http_code}" -X POST "$API/sandboxes" \
  $AUTH -H "Content-Type: application/json" \
  -d '{"templateID":"default","memoryMB":4096,"cpuCount":1}')
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')

if [ "$CODE" = "429" ]; then
  pass "Correctly blocked second sandbox (HTTP 429): $(echo $BODY | grep -o '"error":"[^"]*"')"
else
  SB2_ID=$(echo "$BODY" | grep -o '"sandboxID":"[^"]*"' | head -1 | cut -d'"' -f4)
  fail "Expected 429, got HTTP $CODE (sandbox: $SB2_ID)"
  # Clean up if accidentally created
  if [ -n "$SB2_ID" ]; then
    curl -s -X DELETE "$API/sandboxes/$SB2_ID" $AUTH > /dev/null
  fi
fi
echo ""

# --- Test 3: Try creating an 8GB sandbox (should fail - tier restricted)
info "Test 3: Create 8GB sandbox (should fail - tier restricted)"
# First delete the running sandbox to free up the slot
if [ -n "$SB1_ID" ]; then
  curl -s -X DELETE "$API/sandboxes/$SB1_ID" $AUTH > /dev/null
  sleep 2
fi

RESP=$(curl -s -w "\n%{http_code}" -X POST "$API/sandboxes" \
  $AUTH -H "Content-Type: application/json" \
  -d '{"templateID":"default","memoryMB":8192,"cpuCount":2}')
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')

if [ "$CODE" = "402" ]; then
  pass "Correctly blocked 8GB sandbox (HTTP 402): $(echo $BODY | grep -o '"error":"[^"]*"')"
else
  SB3_ID=$(echo "$BODY" | grep -o '"sandboxID":"[^"]*"' | head -1 | cut -d'"' -f4)
  fail "Expected 402, got HTTP $CODE"
  if [ -n "$SB3_ID" ]; then
    curl -s -X DELETE "$API/sandboxes/$SB3_ID" $AUTH > /dev/null
  fi
fi
echo ""

# --- Test 4: Try creating a 16GB sandbox (should fail)
info "Test 4: Create 16GB sandbox (should fail - tier restricted)"
RESP=$(curl -s -w "\n%{http_code}" -X POST "$API/sandboxes" \
  $AUTH -H "Content-Type: application/json" \
  -d '{"templateID":"default","memoryMB":16384,"cpuCount":4}')
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')

if [ "$CODE" = "402" ]; then
  pass "Correctly blocked 16GB sandbox (HTTP 402)"
else
  fail "Expected 402, got HTTP $CODE"
fi
echo ""

# --- Test 5: Try creating a 32GB sandbox (should fail)
info "Test 5: Create 32GB sandbox (should fail - tier restricted)"
RESP=$(curl -s -w "\n%{http_code}" -X POST "$API/sandboxes" \
  $AUTH -H "Content-Type: application/json" \
  -d '{"templateID":"default","memoryMB":32768,"cpuCount":8}')
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')

if [ "$CODE" = "402" ]; then
  pass "Correctly blocked 32GB sandbox (HTTP 402)"
else
  fail "Expected 402, got HTTP $CODE"
fi
echo ""

# --- Test 6: Default sandbox (no size specified) should get 4GB
info "Test 6: Create default sandbox (should default to 4GB)"
RESP=$(curl -s -w "\n%{http_code}" -X POST "$API/sandboxes" \
  $AUTH -H "Content-Type: application/json" \
  -d '{"templateID":"default"}')
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
SB6_ID=$(echo "$BODY" | grep -o '"sandboxID":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ "$CODE" = "200" ] || [ "$CODE" = "201" ]; then
  pass "Created default sandbox: $SB6_ID (HTTP $CODE)"
else
  fail "Expected 200/201, got HTTP $CODE: $BODY"
fi

# Clean up
if [ -n "$SB6_ID" ]; then
  sleep 1
  curl -s -X DELETE "$API/sandboxes/$SB6_ID" $AUTH > /dev/null
  info "Cleaned up sandbox $SB6_ID"
fi
echo ""

echo "================================================"
echo " Tests complete"
echo "================================================"
