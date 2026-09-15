// The API key stays on the origin the client was configured with. A
// redirect is answered with an error, never followed: following it would
// hand the key to whatever origin the redirect names. Two real HTTP origins
// on the loopback interface and the real global fetch, as the review
// reproduced it; this file is a test and not part of the portable subpath.

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OpenComputer } from "./client.js";
import { OpenComputerError } from "./errors.js";

interface Seen { method: string; url: string; headers: IncomingMessage["headers"] }

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${String(port)}`);
    });
  });
}

const session = {
  id: "ses_1", agentId: "worker", deploymentId: "dep_1", status: "idle", source: "api",
  turns: [], createdAt: "2026-09-15T00:00:00.000Z", updatedAt: "2026-09-15T00:00:00.000Z",
};

describe("redirects", () => {
  const elsewhere: Seen[] = [];
  const configured: Seen[] = [];
  let origin = "";
  let other = "";
  const target = createServer((request, response) => {
    elsewhere.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(session));
  });
  const redirecting = createServer((request, response) => {
    configured.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers });
    response.statusCode = 307;
    response.setHeader("location", `${other}${request.url ?? ""}`);
    response.end();
  });

  beforeAll(async () => {
    other = await listen(target);
    origin = await listen(redirecting);
  });
  afterAll(async () => {
    await new Promise((resolve) => redirecting.close(resolve));
    await new Promise((resolve) => target.close(resolve));
  });

  it("refuses a redirect instead of carrying the API key to another origin", async () => {
    const oc = new OpenComputer({ apiKey: "osb_dummy_key", baseUrl: `${origin}/api/managed-agents` });
    const outcome = await oc.sessions.get("ses_1").catch((cause: unknown) => cause);
    expect(outcome).toBeInstanceOf(OpenComputerError);
    expect(outcome).toMatchObject({ code: "redirected", status: 307 });
    expect((outcome as Error).message).toMatch(/GET \/sessions\/ses_1/);
    expect((outcome as Error).message).not.toContain(other);
    // The configured origin saw the request with the key; the redirect's
    // target saw nothing at all.
    expect(configured).toHaveLength(1);
    expect(configured[0]?.headers["x-api-key"]).toBe("osb_dummy_key");
    expect(elsewhere).toEqual([]);
  });
});
