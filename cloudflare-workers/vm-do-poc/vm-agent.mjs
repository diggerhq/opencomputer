#!/usr/bin/env node
import { spawn } from "node:child_process";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const url = process.env.OC_DO_URL;
const secret = process.env.OC_DO_VM_SECRET;
const probeOnly = process.env.OC_DO_PROBE === "1";
const WebSocketClient = globalThis.WebSocket ?? (await import("ws")).WebSocket;
if (!url || !secret) {
  console.error("OC_DO_URL and OC_DO_VM_SECRET are required");
  process.exit(2);
}

function varint(value) {
  const bytes = [];
  let remaining = value >>> 0;
  while (remaining > 0x7f) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }
  bytes.push(remaining);
  return bytes;
}

function fieldVarint(field, value) {
  return [...varint(field << 3), ...varint(value)];
}

function fieldBytes(field, value) {
  return [...varint((field << 3) | 2), ...varint(value.byteLength), ...value];
}

function stringField(field, value) {
  return value ? fieldBytes(field, encoder.encode(value)) : [];
}

class Reader {
  offset = 0;

  constructor(bytes) {
    this.bytes = bytes;
  }

  get done() {
    return this.offset >= this.bytes.byteLength;
  }

  uint32() {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      if (this.offset >= this.bytes.byteLength) throw new Error("truncated protobuf varint");
      const byte = this.bytes[this.offset++];
      value |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value >>> 0;
    }
    throw new Error("protobuf varint exceeds uint32");
  }

  bytesValue() {
    const length = this.uint32();
    const end = this.offset + length;
    if (end > this.bytes.byteLength) throw new Error("truncated protobuf bytes");
    const value = this.bytes.subarray(this.offset, end);
    this.offset = end;
    return value;
  }

  string() {
    return decoder.decode(this.bytesValue());
  }

  skip(wireType) {
    if (wireType === 0) this.uint32();
    else if (wireType === 2) this.bytesValue();
    else throw new Error(`unsupported protobuf wire type ${wireType}`);
  }
}

function decodeEnv(bytes) {
  const reader = new Reader(bytes);
  let key = "";
  let value = "";
  while (!reader.done) {
    const tag = reader.uint32();
    const field = tag >>> 3;
    const wireType = tag & 7;
    if (field === 1 && wireType === 2) key = reader.string();
    else if (field === 2 && wireType === 2) value = reader.string();
    else reader.skip(wireType);
  }
  return [key, value];
}

function decodeExec(input) {
  const reader = new Reader(new Uint8Array(input));
  const request = { requestId: 0, command: "", cwd: "", timeoutMs: 60_000, env: {} };
  while (!reader.done) {
    const tag = reader.uint32();
    const field = tag >>> 3;
    const wireType = tag & 7;
    if (field === 1 && wireType === 0) request.requestId = reader.uint32();
    else if (field === 2 && wireType === 2) request.command = reader.string();
    else if (field === 3 && wireType === 2) request.cwd = reader.string();
    else if (field === 4 && wireType === 0) request.timeoutMs = reader.uint32();
    else if (field === 5 && wireType === 2) {
      const [key, value] = decodeEnv(reader.bytesValue());
      request.env[key] = value;
    } else reader.skip(wireType);
  }
  if (!request.requestId || !request.command) throw new Error("request_id and command are required");
  return request;
}

function zigZagEncode(value) {
  return ((value << 1) ^ (value >> 31)) >>> 0;
}

function resultFrame(requestId, { exitCode, durationMs, stdout, stderr, error = "" }) {
  return Uint8Array.from([
    ...fieldVarint(1, requestId),
    ...fieldVarint(2, zigZagEncode(exitCode)),
    ...fieldVarint(3, Math.max(0, Math.round(durationMs))),
    ...fieldBytes(4, encoder.encode(stdout)),
    ...fieldBytes(5, encoder.encode(stderr)),
    ...stringField(6, error),
  ]);
}

function execute(request) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const child = spawn("/bin/sh", ["-lc", request.command], {
      cwd: request.cwd || undefined,
      env: { ...process.env, ...request.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), request.timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? (signal ? 128 : 1),
        durationMs: performance.now() - startedAt,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, durationMs: performance.now() - startedAt, stdout: "", stderr: error.message });
    });
  });
}

let retryMs = 250;
function connect() {
  console.log(`connecting to ${new URL(url).host}`);
  const socket = new WebSocketClient(url, ["oc-protobuf-v1", secret]);
  socket.binaryType = "arraybuffer";
  const probeTimer = probeOnly
    ? setTimeout(() => {
        console.error(`probe timed out readyState=${socket.readyState}`);
        process.exit(1);
      }, 15_000)
    : undefined;
  socket.addEventListener("open", () => {
    retryMs = 250;
    console.log(`connected to ${new URL(url).host}`);
    if (probeOnly) socket.close(1000, "probe complete");
  });
  socket.addEventListener("message", async (event) => {
    let request;
    try {
      request = decodeExec(event.data);
      const result = await execute(request);
      socket.send(resultFrame(request.requestId, result));
    } catch (error) {
      if (request) {
        socket.send(resultFrame(request.requestId, {
          exitCode: 1,
          durationMs: 0,
          stdout: "",
          stderr: "",
          error: error instanceof Error ? error.message : String(error),
        }));
      } else console.error("invalid command frame", error);
    }
  });
  socket.addEventListener("close", () => {
    if (probeTimer) clearTimeout(probeTimer);
    if (probeOnly) {
      process.exit(0);
    }
    const delay = retryMs;
    retryMs = Math.min(retryMs * 2, 10_000);
    setTimeout(connect, delay);
  });
  socket.addEventListener("error", (event) => console.error("websocket error", event.message ?? event.error?.message ?? "unknown"));
}

connect();
