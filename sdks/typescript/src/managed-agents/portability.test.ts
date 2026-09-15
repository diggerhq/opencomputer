// The subpath's promise: its module graph loads anywhere fetch exists. Two
// checks. The static one walks every module reachable from the entry and
// refuses any import that is not a relative file, any top-level await, and
// any reference to Node's globals; the dynamic one imports the entry with
// the global fetch replaced by a trap and confirms nothing was called.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function moduleGraph(entry: string): Map<string, string> {
  const seen = new Map<string, string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    const source = readFileSync(file, "utf8");
    seen.set(file, source);
    for (const match of stripComments(source).matchAll(/(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      if (!specifier.startsWith(".")) throw new Error(`${file} imports a non-relative module: ${specifier}`);
      visit(resolve(dirname(file), specifier.replace(/\.js$/, ".ts")));
    }
  };
  visit(entry);
  return seen;
}

describe("@opencomputer/sdk/managed-agents", () => {
  const graph = moduleGraph(resolve(here, "index.ts"));

  it("reaches only relative modules inside its own directory", () => {
    for (const file of graph.keys()) expect(file.startsWith(here)).toBe(true);
    expect([...graph.keys()].map((file) => file.slice(here.length + 1)).sort()).toEqual([
      "client.ts",
      "errors.ts",
      "event-subscriptions.ts",
      "http.ts",
      "index.ts",
      "memory.ts",
      "start-on-document.ts",
      "types.ts",
    ]);
  });

  it("has no top-level await, dynamic import, or Node global in any module", () => {
    for (const [file, source] of graph) {
      const code = stripComments(source);
      // Top-level statements are unindented; an `await` at column 0 is one.
      expect(code, file).not.toMatch(/^await\s/m);
      expect(code, file).not.toMatch(/\bimport\s*\(/);
      expect(code, file).not.toMatch(/\bprocess\b/);
      expect(code, file).not.toMatch(/\brequire\s*\(/);
      expect(code, file).not.toMatch(/\bBuffer\b/);
      expect(code, file).not.toMatch(/["']node:/);
    }
  });

  it("performs no network activity at import and constructs a client that lists sessions", async () => {
    const trap = vi.fn(() => {
      throw new Error("fetch called at import");
    });
    const original = globalThis.fetch;
    globalThis.fetch = trap as unknown as typeof fetch;
    try {
      const mod = await import("./index.js");
      expect(trap).not.toHaveBeenCalled();
      const calls: string[] = [];
      const oc = new mod.OpenComputer({
        apiKey: "k",
        fetch: async (input) => {
          calls.push(String(input));
          return Response.json({ sessions: [], nextCursor: null });
        },
      });
      expect(await oc.sessions.list()).toEqual({ sessions: [], nextCursor: null });
      expect(calls).toEqual(["https://app.opencomputer.dev/api/managed-agents/sessions"]);
      expect(trap).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });
});
