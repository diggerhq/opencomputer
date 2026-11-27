// A sent file read for the dashboard (actors/computer/workspace-file.ts, http/api/result-file.ts):
// what the relay is asked, and what of its answer is served.

import { describe, expect, it } from "vitest";

import { safeFile, workspaceFile } from "../src/actors/computer/workspace-file.js";
import { isWorkspacePath } from "../src/http/api/result-file.js";
import { WIRE_HEADERS } from "../src/wire/auth.js";

const TARGET = { platformKey: "p".repeat(32), tunnelId: "tun1", tunnelDomain: "w.example.dev" };

describe("workspaceFile", () => {
  it("asks the relay for one file of one session, read-only, as the person", async () => {
    let asked: { url: string; headers: Record<string, string> } | undefined;
    const upstream = (async (url: string, init: RequestInit) => {
      asked = { url, headers: init.headers as Record<string, string> };
      return new Response("png", { headers: { "content-type": "image/png", etag: '"e1"' } });
    }) as typeof fetch;
    const r = await workspaceFile(TARGET, { member: "usr_1", sessionId: "cs_1", path: "out/chart one.png", ifNoneMatch: '"e0"' }, upstream);
    expect(asked!.url).toBe("https://tun1.w.example.dev/files/cs_1/file?path=out%2Fchart+one.png");
    expect(asked!.headers[WIRE_HEADERS.member]).toBe("usr_1");
    expect(JSON.parse(atob(asked!.headers[WIRE_HEADERS.scope]!.replace(/-/g, "+").replace(/_/g, "/")))).toEqual({
      scopes: ["sessions:read"],
      sessionIds: ["cs_1"],
      readOnly: true,
    });
    expect(asked!.headers["if-none-match"]).toBe('"e0"');
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(r.headers.get("etag")).toBe('"e1"');
    expect(await r.text()).toBe("png");
  });
});

describe("safeFile", () => {
  const served = (type: string) => safeFile(new Response("x", { headers: { "content-type": type } })).headers;

  it("serves images as they are, never sniffed", () => {
    expect(served("image/webp").get("content-type")).toBe("image/webp");
    expect(served("image/webp").get("x-content-type-options")).toBe("nosniff");
  });

  it("serves markup as plain text or a download, never as a page", () => {
    expect(served("text/html; charset=utf-8").get("content-type")).toBe("text/plain; charset=utf-8");
    expect(served("image/svg+xml").get("content-type")).toBe("application/octet-stream");
    expect(served("image/svg+xml").get("content-disposition")).toBe("attachment");
  });

  it("passes a failure on as it came", async () => {
    const r = safeFile(new Response('{"code":"path_not_found"}', { status: 404 }));
    expect(r.status).toBe(404);
  });
});

describe("isWorkspacePath", () => {
  it("takes a relative path inside the workspace only", () => {
    expect(isWorkspacePath("repo/out.png")).toBe(true);
    for (const bad of ["/tmp/out.png", "../x.png", "a/../../x", "a//b", "", "./a"]) expect(isWorkspacePath(bad)).toBe(false);
  });
});
