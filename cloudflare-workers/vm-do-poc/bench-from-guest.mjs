#!/usr/bin/env node
// Run the TTI benchmark from INSIDE a dev sandbox (client in westus2, same
// region as the POC fleet + wnam DOs) — reproduces the colleague's aligned
// client→ingress→DO→VM geometry instead of a laptop across the triangle.
import { readFile } from "node:fs/promises";
import { Sandbox } from "@opencomputer/sdk";

const apiKey = process.env.OPENCOMPUTER_API_KEY;
const apiUrl = process.env.OPENCOMPUTER_API_URL ?? "https://app2.opensandbox.ai";
const pocUrl = process.env.OC_DO_HTTP_URL;
const benchToken = process.env.OC_POC_BENCH_TOKEN;
const iters = process.env.BENCH_ITERS ?? "29";
const conc = process.env.BENCH_CONC ?? "29";
const mode = process.env.BENCH_MODE ?? ""; // empty = all modes
if (!apiKey || !pocUrl || !benchToken) {
  console.error("OPENCOMPUTER_API_KEY, OC_DO_HTTP_URL, OC_POC_BENCH_TOKEN required");
  process.exit(2);
}

const benchSource = await readFile(new URL("../../benchmarks/tti/bench.mjs", import.meta.url), "utf8");

// 2/8192 tier so the 29-wide client fan-out isn't throttled by a 1-vCPU guest.
const sandbox = await Sandbox.create({ apiUrl, apiKey, template: "base", timeout: 3600, cpuCount: 2, memoryMB: 8192 });
console.error(`client sandbox: ${sandbox.sandboxId}`);
try {
  const dir = "/home/sandbox/ttibench";
  // mkdir + npm via exec BEFORE files.write — the files API and exec sessions
  // run as different users; an API-created dir breaks npm (same pattern as
  // provision-vm.mjs).
  const install = await sandbox.exec.run(
    `mkdir -p ${dir} && cd ${dir} && npm init -y && npm install --no-audit --no-fund @computesdk/opencomputer computesdk`,
    { timeout: 240 },
  );
  await sandbox.files.write(`${dir}/bench.mjs`, benchSource);
  console.error(`npm: exit=${install.exitCode} out=${install.stdout.slice(-200).trim()} err=${install.stderr.slice(-400).trim()}`);
  if (install.exitCode !== 0) throw new Error(`npm install failed (${install.exitCode})`);

  const where = await sandbox.exec.run(
    "curl -sS -m 10 https://www.cloudflare.com/cdn-cgi/trace | grep -E 'colo|ip' | head -2",
    { timeout: 30 },
  );
  console.error(`guest CF ingress: ${where.stdout.trim().replaceAll("\n", " ")}`);

  const modeArg = mode ? `--mode ${mode}` : "";
  const run = await sandbox.exec.run(
    `cd ${dir} && OPENCOMPUTER_API_URL=${pocUrl} OPENCOMPUTER_API_KEY=${benchToken} node bench.mjs ${modeArg} --iterations ${iters} --concurrency ${conc} 2>&1 | tail -14`,
    { timeout: 900, timeoutMs: 900_000 },
  );
  console.log(run.stdout);
  if (run.exitCode !== 0) console.error(`bench exit=${run.exitCode} stderr: ${run.stderr.slice(0, 500)}`);
} finally {
  await sandbox.kill().catch(() => {});
}
