/**
 * Preview URL Test — TypeScript
 *
 * Tests that preview URLs work end-to-end on production.
 *
 * Usage:
 *   OPENCOMPUTER_API_KEY=your-key npx tsx scripts/test-preview-url-prod.ts
 *
 * Or with custom URL:
 *   OPENCOMPUTER_API_URL=http://localhost:8080 OPENCOMPUTER_API_KEY=your-key npx tsx scripts/test-preview-url-prod.ts
 */

const API_URL = process.env.OPENCOMPUTER_API_URL ?? "https://app.opencomputer.dev";
const API_KEY = process.env.OPENCOMPUTER_API_KEY;

if (!API_KEY) {
  console.error("Set OPENCOMPUTER_API_KEY");
  process.exit(1);
}

const headers = { "Content-Type": "application/json", "X-API-Key": API_KEY };

function ok(msg: string) { console.log(`  ✓ ${msg}`); }
function fail(msg: string) { console.log(`  ✗ ${msg}`); }
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log("");
  console.log("╔══════════════════════════════════════╗");
  console.log("║      Preview URL Test                ║");
  console.log("╚══════════════════════════════════════╝");
  console.log("");
  console.log(`  API: ${API_URL}`);
  console.log("");

  let sandboxId = "";

  try {
    // Step 1: Create sandbox
    console.log("━━━ Step 1: Create sandbox ━━━");
    const createResp = await fetch(`${API_URL}/api/sandboxes`, {
      method: "POST",
      headers,
      body: JSON.stringify({ timeout: 300 }),
    });
    const createData = await createResp.json() as any;
    sandboxId = createData.sandboxID;
    ok(`Created: ${sandboxId}`);

    // Step 2: Write HTML and start server
    console.log("");
    console.log("━━━ Step 2: Start web server ━━━");

    const html = `<!DOCTYPE html>
<html>
<head><title>Preview Test</title></head>
<body>
<h1>Preview URL Works!</h1>
<p>Sandbox: ${sandboxId}</p>
<p>Time: <script>document.write(new Date().toISOString())</script></p>
</body>
</html>`;

    await fetch(`${API_URL}/api/sandboxes/${sandboxId}/files?path=/workspace/index.html`, {
      method: "PUT",
      headers: { "X-API-Key": API_KEY, "Content-Type": "application/octet-stream" },
      body: html,
    });
    ok("Wrote /workspace/index.html");

    // Start server
    await fetch(`${API_URL}/api/sandboxes/${sandboxId}/exec/run`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        cmd: "bash",
        args: ["-c", "setsid python3 -m http.server 3000 --directory /workspace </dev/null >/dev/null 2>&1 &"],
        timeout: 5,
      }),
    });
    await sleep(2000);

    // Verify server running internally
    const checkResp = await fetch(`${API_URL}/api/sandboxes/${sandboxId}/exec/run`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        cmd: "bash",
        args: ["-c", "curl -s -o /dev/null -w %{http_code} http://localhost:3000"],
        timeout: 5,
      }),
    });
    const checkData = await checkResp.json() as any;
    const internalStatus = checkData.stdout?.trim();

    if (internalStatus === "200") {
      ok(`Server running on port 3000 (internal: ${internalStatus})`);
    } else {
      fail(`Server NOT running (got: ${JSON.stringify(checkData)})`);
      return;
    }

    // Step 3: Create preview URL
    console.log("");
    console.log("━━━ Step 3: Create preview URL ━━━");

    const previewResp = await fetch(`${API_URL}/api/sandboxes/${sandboxId}/preview`, {
      method: "POST",
      headers,
      body: JSON.stringify({ port: 3000 }),
    });
    const previewData = await previewResp.json() as any;
    const hostname = previewData.hostname;
    const sslStatus = previewData.sslStatus;

    if (hostname) {
      ok(`Preview URL: https://${hostname}`);
      ok(`SSL status: ${sslStatus}`);
    } else {
      fail(`Failed to create preview URL: ${JSON.stringify(previewData)}`);
      return;
    }

    // Step 4: Access preview URL
    console.log("");
    console.log("━━━ Step 4: Access preview URL ━━━");
    await sleep(2000);

    try {
      const pageResp = await fetch(`https://${hostname}`, { signal: AbortSignal.timeout(15000) });
      const body = await pageResp.text();

      if (pageResp.status === 200) {
        ok(`HTTPS access: ${pageResp.status}`);
        if (body.includes("Preview URL Works")) {
          ok("Content verified: page contains expected text");
        } else {
          fail(`Got 200 but unexpected content: ${body.slice(0, 200)}`);
        }
      } else {
        fail(`HTTPS access failed: HTTP ${pageResp.status}`);
        console.log(`  Body: ${body.slice(0, 200)}`);
      }
    } catch (e: any) {
      fail(`HTTPS access error: ${e.message}`);
    }

    console.log("");
    console.log("━━━ All checks passed! ━━━");
    console.log("");
    console.log(`  Preview live at: https://${hostname}`);
    console.log(`  Sandbox: ${sandboxId}`);
    console.log("");
    console.log("  Sandbox and preview URL are still running.");
    console.log("  Press Ctrl+C to destroy and exit.");
    console.log("");

    await new Promise<void>((resolve) => {
      process.on("SIGINT", () => {
        console.log("\nCleaning up...");
        resolve();
      });
    });

  } finally {
    if (sandboxId) {
      console.log(`Destroying sandbox ${sandboxId}...`);
      await fetch(`${API_URL}/api/sandboxes/${sandboxId}`, {
        method: "DELETE",
        headers,
      }).catch(() => {});
      console.log("Done.");
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
