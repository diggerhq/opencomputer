#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { Sandbox } from "@opencomputer/sdk";

const apiKey = process.env.OPENCOMPUTER_API_KEY ?? process.env.OPENCOMPUTER_DEV_API_KEY;
const vmSecret = process.env.OC_DO_VM_SECRET;
const benchToken = process.env.OC_POC_BENCH_TOKEN;
const apiUrl = process.env.OPENCOMPUTER_API_URL ?? process.env.OPENCOMPUTER_DEV_API_URL ?? "https://mo-oc-dev.com";
const pocUrl = process.env.OC_DO_HTTP_URL ?? "https://vm-do-poc.mo-oc-dev.com";
const sandboxTimeout = Number(process.env.OC_POC_SANDBOX_TIMEOUT ?? "3600");
const vmId = process.env.OC_POC_VM_ID ?? "vm-seoul-1";
const sandboxId = process.env.OC_POC_SANDBOX_ID;
const createOnly = process.env.OC_POC_CREATE_ONLY === "1";
const socketUrl = `${pocUrl.replace(/^http/, "ws")}/internal/vms/${vmId}/connect`;

if (!apiKey || (!createOnly && (!vmSecret || !benchToken))) {
  console.error("OPENCOMPUTER_API_KEY is required; attaching also requires OC_DO_VM_SECRET and OC_POC_BENCH_TOKEN");
  process.exit(2);
}

const agentSource = await readFile(new URL("./vm-agent.mjs", import.meta.url), "utf8");
let sandbox;
try {
  sandbox = sandboxId
    ? await Sandbox.connect(sandboxId, { apiUrl, apiKey })
    : await Sandbox.create({
        apiUrl,
        apiKey,
        template: "base",
        timeout: sandboxTimeout,
        cpuCount: 1,
        memoryMB: 1024,
      });
  if (createOnly) {
    console.log(JSON.stringify({ sandboxId: sandbox.id, status: sandbox.status }));
    process.exit(0);
  }
  const connectorDir = "/home/sandbox/.opencomputer-vm-do-agent";
  const install = await sandbox.exec.run(`mkdir -p ${connectorDir} && npm install --prefix ${connectorDir} --no-audit --no-fund ws@8.21.1`);
  if (install.exitCode !== 0) throw new Error(`install ws failed: ${install.stderr}`);
  await sandbox.files.write(`${connectorDir}/agent.mjs`, agentSource);
  const runtime = await sandbox.exec.run("node -p 'process.version' && curl -fsS --max-time 10 https://vm-do-poc.mo-oc-dev.com/health");
  console.log(JSON.stringify({ sandboxId: sandbox.id, runtime: runtime.stdout.trim() }));
  const probe = await sandbox.exec.run(`node ${connectorDir}/agent.mjs`, {
    env: {
      OC_DO_URL: socketUrl,
      OC_DO_VM_SECRET: vmSecret,
      OC_DO_PROBE: "1",
    },
    timeout: 30,
  });
  console.log(JSON.stringify({ sandboxId: sandbox.id, probe: probe.stdout.trim(), probeStderr: probe.stderr.trim() }));
  if (probe.exitCode !== 0) throw new Error(`VM WebSocket probe exited ${probe.exitCode}`);
  const session = await sandbox.exec.background("node", {
    args: [`${connectorDir}/agent.mjs`],
    env: {
      OC_DO_URL: socketUrl,
      OC_DO_VM_SECRET: vmSecret,
    },
    maxRunAfterDisconnect: sandboxTimeout,
    onStdout: (chunk) => process.stderr.write(`[vm-agent stdout] ${new TextDecoder().decode(chunk)}`),
    onStderr: (chunk) => process.stderr.write(`[vm-agent stderr] ${new TextDecoder().decode(chunk)}`),
  });

  const deadline = Date.now() + 60_000;
  let connected = false;
  while (Date.now() < deadline) {
    const response = await fetch(`${pocUrl}/api/sandboxes/${vmId}/exec/run-async`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": benchToken },
      body: JSON.stringify({ cmd: "sh", args: ["-c", "true"], timeout: 5 }),
    });
    if (response.ok) {
      connected = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!connected) throw new Error("VM agent did not connect to its Durable Object within 60s");

  session.close();
  console.log(JSON.stringify({ sandboxId: sandbox.id, agentSessionId: session.sessionId, socketUrl }));
} catch (error) {
  if (sandbox) await sandbox.kill().catch(() => {});
  throw error;
}
