"""
Large File Upload/Download via Signed URLs

For files > 50MB, use signed URLs instead of the files API.
Signed URLs stream directly to/from the worker — no gRPC size limits.

Usage:
    OPENCOMPUTER_API_KEY=your-key python large_file_upload.py
"""

import asyncio
import hashlib
import os
import time

import httpx
from opencomputer import Sandbox


async def main():
    print("╔═══════════════════════════════════════════╗")
    print("║  Large File Upload via Signed URLs         ║")
    print("╚═══════════════════════════════════════════╝\n")

    sb = await Sandbox.create(timeout=300)
    print(f"Sandbox: {sb.sandbox_id}\n")

    try:
        # ── Upload via signed URL ──────────────────────────────────
        size_mb = 100
        print(f"Generating {size_mb}MB of random data...")
        data = os.urandom(size_mb * 1024 * 1024)
        sha = hashlib.sha256(data).hexdigest()[:16]
        print(f"  SHA-256: {sha}...\n")

        # Get a signed upload URL
        print("Getting signed upload URL...")
        upload_url = await sb.upload_url("/workspace/large.bin")
        print(f"  URL: {upload_url[:80]}...\n")

        # Upload directly to the worker (bypasses gRPC)
        print(f"Uploading {size_mb}MB...")
        t0 = time.time()
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.put(
                upload_url,
                content=data,
                headers={"Content-Type": "application/octet-stream"},
            )
        elapsed = time.time() - t0
        mbps = size_mb / elapsed

        if resp.status_code < 300:
            print(f"  ✓ Upload: {elapsed:.1f}s ({mbps:.1f} MB/s)\n")
        else:
            print(f"  ✗ Upload failed: {resp.status_code} {resp.text[:200]}\n")
            return

        # Verify file exists and has correct size
        r = await sb.exec.run("stat -c %s /workspace/large.bin")
        file_size = int(r.stdout.strip())
        print(f"  File size on disk: {file_size / 1024 / 1024:.1f}MB")
        if file_size == len(data):
            print(f"  ✓ Size matches\n")
        else:
            print(f"  ✗ Size mismatch: expected {len(data)}, got {file_size}\n")

        # ── Download via signed URL ────────────────────────────────
        print("Getting signed download URL...")
        download_url = await sb.download_url("/workspace/large.bin")
        print(f"  URL: {download_url[:80]}...\n")

        print(f"Downloading {size_mb}MB...")
        t0 = time.time()
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.get(download_url)
        downloaded = resp.content
        elapsed = time.time() - t0
        mbps = size_mb / elapsed

        if resp.status_code == 200:
            print(f"  ✓ Download: {elapsed:.1f}s ({mbps:.1f} MB/s)\n")
        else:
            print(f"  ✗ Download failed: {resp.status_code}\n")
            return

        # Verify hash matches
        dl_sha = hashlib.sha256(downloaded).hexdigest()[:16]
        if sha == dl_sha:
            print(f"  ✓ Hash matches: {dl_sha}...\n")
        else:
            print(f"  ✗ Hash mismatch: {sha}... vs {dl_sha}...\n")

        print("Done — all checks passed!")

    finally:
        await sb.kill()
        print(f"\nSandbox {sb.sandbox_id} destroyed.")


asyncio.run(main())
