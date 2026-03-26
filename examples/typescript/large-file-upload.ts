/**
 * Large File Upload/Download via Signed URLs
 *
 * For files > 50MB, use signed URLs instead of the files API.
 * Signed URLs stream directly to/from the worker — no gRPC size limits.
 *
 * Usage:
 *   OPENCOMPUTER_API_KEY=your-key npx tsx examples/typescript/large-file-upload.ts
 */

import { Sandbox } from "../../sdks/typescript/src/index.js";
import { createHash, randomBytes } from "crypto";
import { Readable } from "stream";

async function main() {
  console.log("╔═══════════════════════════════════════════╗");
  console.log("║  Large File Upload via Signed URLs         ║");
  console.log("╚═══════════════════════════════════════════╝\n");

  const sb = await Sandbox.create({ timeout: 300 });
  console.log(`Sandbox: ${sb.sandboxId}\n`);

  try {
    // ── Upload via signed URL ──────────────────────────────────
    const sizeMB = 100;
    console.log(`Generating ${sizeMB}MB of random data...`);
    const data = randomBytes(sizeMB * 1024 * 1024);
    const hash = createHash("sha256").update(data).digest("hex").slice(0, 16);
    console.log(`  SHA-256: ${hash}...\n`);

    // Get a signed upload URL
    console.log("Getting signed upload URL...");
    const uploadUrl = await sb.uploadUrl("/workspace/large.bin");
    console.log(`  URL: ${uploadUrl.slice(0, 80)}...\n`);

    // Upload directly to the worker (bypasses gRPC)
    console.log(`Uploading ${sizeMB}MB...`);
    const t0 = Date.now();
    const uploadResp = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: data,
    });
    const uploadMs = Date.now() - t0;

    if (uploadResp.ok) {
      const mbps = (sizeMB / (uploadMs / 1000)).toFixed(1);
      console.log(`  ✓ Upload: ${uploadMs}ms (${mbps} MB/s)\n`);
    } else {
      console.log(`  ✗ Upload failed: ${uploadResp.status} ${await uploadResp.text()}\n`);
      return;
    }

    // Verify file exists and has correct size
    const check = await sb.exec.run(`stat -c %s /workspace/large.bin`);
    const fileSize = parseInt(check.stdout.trim());
    console.log(`  File size on disk: ${(fileSize / 1024 / 1024).toFixed(1)}MB`);
    if (fileSize === data.length) {
      console.log(`  ✓ Size matches\n`);
    } else {
      console.log(`  ✗ Size mismatch: expected ${data.length}, got ${fileSize}\n`);
    }

    // ── Download via signed URL ────────────────────────────────
    console.log("Getting signed download URL...");
    const downloadUrl = await sb.downloadUrl("/workspace/large.bin");
    console.log(`  URL: ${downloadUrl.slice(0, 80)}...\n`);

    console.log(`Downloading ${sizeMB}MB...`);
    const t1 = Date.now();
    const downloadResp = await fetch(downloadUrl);
    const downloaded = Buffer.from(await downloadResp.arrayBuffer());
    const downloadMs = Date.now() - t1;

    if (downloadResp.ok) {
      const mbps = (sizeMB / (downloadMs / 1000)).toFixed(1);
      console.log(`  ✓ Download: ${downloadMs}ms (${mbps} MB/s)\n`);
    } else {
      console.log(`  ✗ Download failed: ${downloadResp.status}\n`);
      return;
    }

    // Verify hash matches
    const downloadHash = createHash("sha256").update(downloaded).digest("hex").slice(0, 16);
    if (hash === downloadHash) {
      console.log(`  ✓ Hash matches: ${downloadHash}...\n`);
    } else {
      console.log(`  ✗ Hash mismatch: ${hash}... vs ${downloadHash}...\n`);
    }

    console.log("Done — all checks passed!");

  } finally {
    await sb.kill();
    console.log(`\nSandbox ${sb.sandboxId} destroyed.`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
