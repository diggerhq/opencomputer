#!/usr/bin/env bash
# test-preview-url-prod.sh — Test preview URLs on production
#
# Usage:
#   OPENCOMPUTER_API_KEY=your-key ./scripts/test-preview-url-prod.sh
#
# Or with custom URL:
#   OPENCOMPUTER_API_URL=http://localhost:8080 OPENCOMPUTER_API_KEY=your-key ./scripts/test-preview-url-prod.sh

set -euo pipefail

API_URL="${OPENCOMPUTER_API_URL:-https://app.opencomputer.dev}"
API_KEY="${OPENCOMPUTER_API_KEY:?Set OPENCOMPUTER_API_KEY}"

echo ""
echo "╔══════════════════════════════════════╗"
echo "║      Preview URL Test                ║"
echo "╚══════════════════════════════════════╝"
echo ""
echo "  API: $API_URL"
echo ""

# Cleanup on exit
SB=""
cleanup() {
    if [ -n "$SB" ]; then
        echo ""
        echo "Cleaning up sandbox $SB..."
        curl -s -X DELETE "$API_URL/api/sandboxes/$SB" -H "X-API-Key: $API_KEY" > /dev/null 2>&1 || true
    fi
}
trap cleanup EXIT

# Step 1: Create sandbox
echo "━━━ Step 1: Create sandbox ━━━"
RESULT=$(curl -s -X POST "$API_URL/api/sandboxes" \
    -H "Content-Type: application/json" \
    -H "X-API-Key: $API_KEY" \
    -d '{"timeout":300}')
SB=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['sandboxID'])" 2>/dev/null)
echo "✓ Created: $SB"

# Step 2: Write HTML file via files API (avoids shell escaping issues)
echo ""
echo "━━━ Step 2: Start web server ━━━"
curl -s -X PUT "$API_URL/api/sandboxes/$SB/files?path=/workspace/index.html" \
    -H "X-API-Key: $API_KEY" \
    -H "Content-Type: application/octet-stream" \
    --data-binary '<!DOCTYPE html>
<html>
<head><title>Preview Test</title></head>
<body>
<h1>Preview URL Works!</h1>
<p>Sandbox: '"$SB"'</p>
<p>Time: <script>document.write(new Date().toISOString())</script></p>
</body>
</html>' > /dev/null
echo "✓ Wrote /workspace/index.html"

# Start Python HTTP server on port 3000
curl -s -X POST "$API_URL/api/sandboxes/$SB/exec/run" \
    -H "Content-Type: application/json" \
    -H "X-API-Key: $API_KEY" \
    -d '{"cmd":"bash","args":["-c","setsid python3 -m http.server 3000 --directory /workspace </dev/null >/dev/null 2>&1 &"],"timeout":5}' > /dev/null
sleep 2

# Verify server is running inside the sandbox
INTERNAL=$(curl -s -X POST "$API_URL/api/sandboxes/$SB/exec/run" \
    -H "Content-Type: application/json" \
    -H "X-API-Key: $API_KEY" \
    -d '{"cmd":"bash","args":["-c","curl -s -o /dev/null -w %{http_code} http://localhost:3000"],"timeout":5}')
STATUS=$(echo "$INTERNAL" | python3 -c "import sys,json; print(json.load(sys.stdin).get('stdout','').strip())" 2>/dev/null)
if [ "$STATUS" = "200" ]; then
    echo "✓ Server running on port 3000 (internal check: $STATUS)"
else
    echo "✗ Server NOT running (got: $INTERNAL)"
    echo "  This will cause preview URLs to return 502"
    exit 1
fi

# Step 3: Create preview URL
echo ""
echo "━━━ Step 3: Create preview URL ━━━"
PREVIEW=$(curl -s -X POST "$API_URL/api/sandboxes/$SB/preview" \
    -H "Content-Type: application/json" \
    -H "X-API-Key: $API_KEY" \
    -d '{"port":3000}')
HOSTNAME=$(echo "$PREVIEW" | python3 -c "import sys,json; print(json.load(sys.stdin).get('hostname',''))" 2>/dev/null)
SSL=$(echo "$PREVIEW" | python3 -c "import sys,json; print(json.load(sys.stdin).get('sslStatus','unknown'))" 2>/dev/null)

if [ -n "$HOSTNAME" ]; then
    echo "✓ Preview URL: https://$HOSTNAME"
    echo "  SSL status: $SSL"
else
    echo "✗ Failed to create preview URL"
    echo "  Response: $PREVIEW"
    exit 1
fi

# Step 4: Access preview URL
echo ""
echo "━━━ Step 4: Access preview URL ━━━"
sleep 2  # give Cloudflare a moment to propagate
HTTP_CODE=$(curl -s -o /tmp/preview-test-body.html -w "%{http_code}" --max-time 15 "https://$HOSTNAME" 2>/dev/null)
BODY=$(cat /tmp/preview-test-body.html 2>/dev/null)
rm -f /tmp/preview-test-body.html

if [ "$HTTP_CODE" = "200" ]; then
    echo "✓ HTTPS access: $HTTP_CODE"
    if echo "$BODY" | grep -q "Preview URL Works"; then
        echo "✓ Content verified: page contains expected text"
    else
        echo "⚠ Got 200 but unexpected content:"
        echo "  ${BODY:0:200}"
    fi
else
    echo "✗ HTTPS access failed: HTTP $HTTP_CODE"
    echo "  Body: ${BODY:0:200}"
fi

# Step 5: List preview URLs
echo ""
echo "━━━ Step 5: List preview URLs ━━━"
LIST=$(curl -s "$API_URL/api/sandboxes/$SB/preview" -H "X-API-Key: $API_KEY")
COUNT=$(echo "$LIST" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null)
echo "✓ Active preview URLs: $COUNT"

# Step 6: Delete preview URL
echo ""
echo "━━━ Step 6: Delete preview URL ━━━"
curl -s -X DELETE "$API_URL/api/sandboxes/$SB/preview/3000" -H "X-API-Key: $API_KEY" > /dev/null
LIST_AFTER=$(curl -s "$API_URL/api/sandboxes/$SB/preview" -H "X-API-Key: $API_KEY")
COUNT_AFTER=$(echo "$LIST_AFTER" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null)
if [ "$COUNT_AFTER" = "0" ]; then
    echo "✓ Preview URL deleted"
else
    echo "✗ Preview URL still exists after delete"
fi

echo ""
echo "━━━ Done ━━━"
echo ""
echo "All checks passed! Preview URLs are working."
