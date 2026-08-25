import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { exchangeCodeOnCallback } from "./codex-oauth.js";

async function availablePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

test("Codex OAuth callback closes its listener before resolving", async () => {
  const port = await availablePort();
  const code = await exchangeCodeOnCallback(
    "https://auth.openai.com/oauth/authorize",
    "expected-state",
    port,
    () => {
      void fetch(
        `http://127.0.0.1:${port}/auth/callback?code=test-code&state=expected-state`,
      );
    },
  );
  assert.equal(code, "test-code");

  const rebound = http.createServer();
  await new Promise<void>((resolve) =>
    rebound.listen(port, "127.0.0.1", resolve),
  );
  await new Promise<void>((resolve, reject) =>
    rebound.close((error) => (error ? reject(error) : resolve())),
  );
});
