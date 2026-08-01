import assert from "node:assert/strict";
import test from "node:test";
import { OpenComputerClient } from "./api.js";

test("reads channels from the public managed-agents response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      channels: [
        {
          id: "channel-1",
          channel: "slack",
          agentId: "agent-1",
          alias: "production",
          teamName: "OpenComputer",
          status: "connected",
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
      ],
    });

  try {
    const client = new OpenComputerClient({
      apiUrl: "https://app.opencomputer.dev",
      apiKey: "osb_test",
    });
    assert.deepEqual(await client.channelConnections(), [
      {
        id: "channel-1",
        channel: "slack",
        agentId: "agent-1",
        alias: "production",
        teamName: "OpenComputer",
        status: "connected",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
