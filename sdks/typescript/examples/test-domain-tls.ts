/**
 * Domain & TLS Verification Test
 *
 * Tests:
 *   1. Each sandbox gets a unique subdomain
 *   2. HTTPS works with valid Let's Encrypt cert
 *   3. HTTP server inside sandbox is reachable via subdomain
 *   4. Multiple subdomains get individual certs
 *   5. Subdomain routes to correct sandbox
 *
 * Usage:
 *   npx tsx examples/test-domain-tls.ts
 */

import { Sandbox } from "../src/index";
import * as tls from "tls";

function green(msg: string) { console.log(`\x1b[32m✓ ${msg}\x1b[0m`); }
function red(msg: string) { console.log(`\x1b[31m✗ ${msg}\x1b[0m`); }
function bold(msg: string) { console.log(`\x1b[1m${msg}\x1b[0m`); }
function dim(msg: string) { console.log(`\x1b[2m  ${msg}\x1b[0m`); }

function sleep(ms: number) {
  return new Promise((r) => globalThis.setTimeout(r, ms));
}

let passed = 0;
let failed = 0;

function check(desc: string, condition: boolean, detail?: string) {
  if (condition) {
    green(desc);
    passed++;
  } else {
    red(`${desc}${detail ? ` (${detail})` : ""}`);
    failed++;
  }
}

function getTlsCertInfo(hostname: string): Promise<{ issuer: string; subject: string; validTo: string; valid: boolean }> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(443, hostname, { servername: hostname }, () => {
      const cert = socket.getPeerCertificate();
      const authorized = socket.authorized;
      socket.end();
      resolve({
        issuer: cert.issuer?.O || "unknown",
        subject: cert.subject?.CN || "unknown",
        validTo: cert.valid_to || "unknown",
        valid: authorized,
      });
    });
    socket.on("error", reject);
    socket.setTimeout(10000, () => {
      socket.destroy();
      reject(new Error("TLS connection timeout"));
    });
  });
}

// Simple HTTP server for sandbox
const HTTP_SERVER = `
const http = require('http');
const os = require('os');
const server = http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type':'application/json'});
  res.end(JSON.stringify({
    path: req.url,
    hostname: os.hostname(),
    sandboxId: process.env.SANDBOX_ID || 'unknown',
    timestamp: Date.now()
  }));
});
server.listen(80, '0.0.0.0', () => console.log('Server ready'));
`;

async function main() {
  bold("\n╔══════════════════════════════════════════════════╗");
  bold("║       Domain & TLS Verification Test             ║");
  bold("╚══════════════════════════════════════════════════╝\n");

  const sandboxes: Sandbox[] = [];

  try {
    // ── Test 1: Unique subdomains ───────────────────────────────────
    bold("━━━ Test 1: Unique subdomain assignment ━━━\n");

    // Create 3 sandboxes and verify unique domains
    for (let i = 0; i < 3; i++) {
      const sb = await Sandbox.create({ template: "node", timeout: 120 });
      sandboxes.push(sb);
      dim(`Sandbox ${i + 1}: ${sb.sandboxId} → ${sb.domain}`);
    }

    const domains = sandboxes.map(s => s.domain);
    const uniqueDomains = new Set(domains);
    check("All 3 sandboxes got unique domains", uniqueDomains.size === 3);

    // Extract the base domain dynamically from the first sandbox's domain
    // e.g., "sb-abc123.dev.workers.opensandbox.ai" → baseDomain = "dev.workers.opensandbox.ai"
    const firstDomain = domains[0] || "";
    const firstDot = firstDomain.indexOf(".");
    const baseDomain = firstDot > 0 ? firstDomain.slice(firstDot + 1) : "";
    dim(`Base domain: ${baseDomain}`);

    check("All domains share the same base domain",
      domains.every(d => d.endsWith(`.${baseDomain}`)));
    check("All domains have a single-level subdomain prefix",
      domains.every(d => d.replace(`.${baseDomain}`, "").indexOf(".") === -1));
    console.log();

    // ── Test 2: TLS certificate validation ──────────────────────────
    bold("━━━ Test 2: TLS certificate validation ━━━\n");

    // Start HTTP servers on all sandboxes
    for (let i = 0; i < sandboxes.length; i++) {
      await sandboxes[i].files.write("/tmp/server.js", HTTP_SERVER);
      await sandboxes[i].commands.run(
        `SANDBOX_ID=${sandboxes[i].sandboxId} nohup node /tmp/server.js > /tmp/server.log 2>&1 &`,
      );
    }
    await sleep(2000);

    // Check TLS cert on first sandbox
    try {
      const certInfo = await getTlsCertInfo(sandboxes[0].domain);
      check("TLS certificate is valid", certInfo.valid);
      check("Certificate issued by Let's Encrypt or similar",
        certInfo.issuer.includes("Let's Encrypt") ||
        certInfo.issuer.includes("R3") ||
        certInfo.issuer.includes("R10") ||
        certInfo.issuer.includes("R11") ||
        certInfo.issuer.includes("E5") ||
        certInfo.issuer.includes("E6"),
        certInfo.issuer);
      dim(`Issuer: ${certInfo.issuer}`);
      dim(`Subject: ${certInfo.subject}`);
      dim(`Valid to: ${certInfo.validTo}`);
    } catch (err: any) {
      check("TLS connection succeeded", false, err.message);
    }
    console.log();

    // ── Test 3: HTTPS requests work ─────────────────────────────────
    bold("━━━ Test 3: HTTPS requests to sandbox servers ━━━\n");

    // Preview URLs use the format: {sandboxID}-p{port}.{baseDomain}
    function previewUrl(sb: Sandbox, path: string): string {
      return `https://${sb.sandboxId}-p80.${baseDomain}${path}`;
    }

    for (let i = 0; i < sandboxes.length; i++) {
      try {
        const url = previewUrl(sandboxes[i], "/test-path");
        dim(`URL: ${url}`);
        const resp = await fetch(url);
        check(`Sandbox ${i + 1}: HTTPS 200`, resp.ok, `status ${resp.status}`);

        if (resp.ok) {
          const data = await resp.json();
          check(`Sandbox ${i + 1}: correct path`, data.path === "/test-path", data.path);
          check(`Sandbox ${i + 1}: has hostname`, !!data.hostname);
        }
      } catch (err: any) {
        check(`Sandbox ${i + 1}: HTTPS request`, false, err.message);
      }
    }
    console.log();

    // ── Test 4: Subdomain routes to correct sandbox ─────────────────
    bold("━━━ Test 4: Subdomain routing isolation ━━━\n");

    // Each sandbox server returns its sandbox ID — verify routing is correct
    const routingResults = await Promise.all(
      sandboxes.map(async (sb, i) => {
        try {
          const resp = await fetch(previewUrl(sb, "/"));
          const data = await resp.json();
          return { index: i, sandboxId: sb.sandboxId, returnedId: data.sandboxId, hostname: data.hostname };
        } catch (err: any) {
          return { index: i, sandboxId: sb.sandboxId, returnedId: "error", hostname: err.message };
        }
      }),
    );

    for (const r of routingResults) {
      check(
        `Sandbox ${r.index + 1}: routed to correct container`,
        r.returnedId === r.sandboxId,
        `expected ${r.sandboxId}, got ${r.returnedId}`,
      );
    }

    // Cross-check: request to sandbox 1's domain should NOT get sandbox 2's response
    if (sandboxes.length >= 2) {
      const cross1 = await fetch(previewUrl(sandboxes[0], "/"));
      const cross1Data = await cross1.json();
      const cross2 = await fetch(previewUrl(sandboxes[1], "/"));
      const cross2Data = await cross2.json();
      check(
        "Cross-routing: different sandboxes return different IDs",
        cross1Data.sandboxId !== cross2Data.sandboxId,
      );
    }
    console.log();

    // ── Test 5: Multiple methods ────────────────────────────────────
    bold("━━━ Test 5: HTTP methods through TLS ━━━\n");

    const getResp = await fetch(previewUrl(sandboxes[0], "/get-test"));
    check("GET request works", getResp.ok);

    const postResp = await fetch(previewUrl(sandboxes[0], "/post-test"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ test: true }),
    });
    check("POST request works", postResp.ok);

    const putResp = await fetch(previewUrl(sandboxes[0], "/put-test"), {
      method: "PUT",
      body: "put-data",
    });
    check("PUT request works", putResp.ok);
    console.log();

  } catch (err: any) {
    red(`Fatal error: ${err.message}`);
    if (err.stack) dim(err.stack);
    failed++;
  } finally {
    // Kill all sandboxes
    for (const sb of sandboxes) {
      try { await sb.kill(); } catch {}
    }
    if (sandboxes.length > 0) green(`${sandboxes.length} sandboxes killed`);
  }

  // --- Summary ---
  bold("========================================");
  bold(` Results: ${passed} passed, ${failed} failed`);
  bold("========================================\n");
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
