#!/usr/bin/env node

const baseUrl = process.env.OC_DO_HTTP_URL ?? "https://vm-do-poc.mo-oc-dev.com";
const token = process.env.OC_POC_BENCH_TOKEN;
const iterations = Number(process.env.ITERATIONS ?? "20");
const vmId = process.env.OC_POC_VM_ID ?? "vm-seoul-1";
if (!token) throw new Error("OC_POC_BENCH_TOKEN is required");

const samples = [];
for (let i = 0; i < iterations; i++) {
  const t0 = performance.now();
  const createResponse = await fetch(`${baseUrl}/api/sandboxes`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": token },
    body: "{}",
  });
  const t1 = performance.now();
  if (!createResponse.ok) throw new Error(`create failed: ${createResponse.status} ${await createResponse.text()}`);
  const create = await createResponse.json();

  const execResponse = await fetch(`${baseUrl}/api/sandboxes/${vmId}/exec/run-async`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": token },
    body: JSON.stringify({ cmd: "sh", args: ["-c", "node -v"], timeout: 30 }),
  });
  const t2 = performance.now();
  if (!execResponse.ok) throw new Error(`exec failed: ${execResponse.status} ${await execResponse.text()}`);
  const exec = await execResponse.json();
  samples.push({
    createClientMs: t1 - t0,
    createEdgeMs: create.pocTiming?.createEdgeMs,
    execClientMs: t2 - t1,
    durableObjectMs: exec.pocTiming?.durableObjectMs,
    vmProcessMs: exec.pocTiming?.vmProcessMs,
    totalMs: t2 - t0,
  });
}

function summarize(key) {
  const values = samples.map((sample) => sample[key]).filter(Number.isFinite).sort((a, b) => a - b);
  const at = (p) => values[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)];
  const middle = Math.floor(values.length / 2);
  const median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
  return { median: Number(median.toFixed(2)), p95: Number(at(0.95).toFixed(2)), min: Number(values[0].toFixed(2)) };
}

console.log(JSON.stringify({
  iterations,
  createClientMs: summarize("createClientMs"),
  createEdgeMs: summarize("createEdgeMs"),
  execClientMs: summarize("execClientMs"),
  durableObjectMs: summarize("durableObjectMs"),
  vmProcessMs: summarize("vmProcessMs"),
  totalMs: summarize("totalMs"),
}, null, 2));
