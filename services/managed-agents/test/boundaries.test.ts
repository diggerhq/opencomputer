// Import boundaries of src/ (work 122): the library-shaped directories import no actor and no route;
// actors import no route; and code outside an actor reaches it only through its contract.ts (a Worker
// entry may also import the class it exports). EXISTING lists what breaks a rule today; it only shrinks.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.join(__dirname, "..", "src");
const LIBRARIES = ["durable", "encoding", "ids", "telemetry", "crypto", "api-objects", "host-protocol", "slack-api", "auth"];
/** Worker entries: they export Durable Object classes, so they import `durable-object.ts`. */
const ENTRIES = ["edge/index.ts", "actors/live/worker.ts", "previews/index.ts", "selfhost/entry.ts"];
const EXISTING: string[] = [
  "edge/computer-grants.ts -> actors/computer/durable-object.ts (reaches into an actor past its contract)",
  "edge/index.ts -> actors/computer/config.ts (reaches into an actor past its contract)",
  "edge/index.ts -> actors/org/work-index.ts (reaches into an actor past its contract)",
  "http/agent-body.ts -> actors/computer/held-for-org/model-access/model-access.ts (reaches into an actor past its contract)",
  "http/api/dispatch.ts -> actors/computer/config.ts (reaches into an actor past its contract)",
  "http/api/dispatch.ts -> actors/computer/held-for-org/secrets/secrets-store.ts (reaches into an actor past its contract)",
  "http/api/pull-access.ts -> actors/computer/held-for-org/github.ts (reaches into an actor past its contract)",
  "http/computer-objects.ts -> actors/computer/config.ts (reaches into an actor past its contract)",
  "http/computer-objects.ts -> actors/computer/durable-object.ts (reaches into an actor past its contract)",
  "http/computer-objects.ts -> actors/connect-codes/codes.ts (reaches into an actor past its contract)",
  "http/connect/with-code.ts -> actors/computer/config.ts (reaches into an actor past its contract)",
  "http/connect/with-code.ts -> actors/computer/held-for-org/model-access/harnesses.ts (reaches into an actor past its contract)",
  "http/connect/with-code.ts -> actors/connect-codes/codes.ts (reaches into an actor past its contract)",
  "http/dashboard/routes.ts -> actors/computer/config.ts (reaches into an actor past its contract)",
  "http/dashboard/routes.ts -> actors/computer/durable-object.ts (reaches into an actor past its contract)",
  "http/dashboard/routes.ts -> actors/computer/held-for-org/model-access/model-access.ts (reaches into an actor past its contract)",
  "http/host/upgrade.ts -> actors/computer/config.ts (reaches into an actor past its contract)",
  "http/host/upgrade.ts -> actors/computer/host-link/host-token.ts (reaches into an actor past its contract)",
  "http/public-routes.ts -> actors/computer/config.ts (reaches into an actor past its contract)",
  "http/slack/webhooks.ts -> actors/computer/config.ts (reaches into an actor past its contract)",
  "platform/computers/arm.ts -> actors/computer/machine/placement.ts (reaches into an actor past its contract)",
  "platform/computers/resources.ts -> actors/computer/machine/placement.ts (reaches into an actor past its contract)",
  "platform/computers/routes.ts -> actors/computer/machine/cloud-contract.ts (reaches into an actor past its contract)",
];

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.name === "node_modules" ? [] : e.isDirectory() ? files(path.join(dir, e.name)) : /\.ts$/.test(e.name) && !e.name.endsWith(".d.ts") ? [path.join(dir, e.name)] : [],
  );
const IMPORT = /^\s*(?:import|export)\b[^'"]*?from\s+['"](\.[^'"]+)['"]|\bimport\(\s*['"](\.[^'"]+)['"]\s*\)/gm;
/** computer-pool and connect-codes are roles of the one ComputerDurableObject class: one family with computer. */
const FAMILY: Record<string, string> = { "computer-pool": "computer", "connect-codes": "computer" };
const actorOf = (rel: string) => {
  const a = /^actors\/([^/]+)\//.exec(rel)?.[1];
  return a && (FAMILY[a] ?? a);
};

function violations(): string[] {
  const out: string[] = [];
  for (const abs of files(SRC)) {
    const from = path.relative(SRC, abs);
    for (const m of readFileSync(abs, "utf8").matchAll(IMPORT)) {
      const to = path.relative(SRC, path.resolve(path.dirname(abs), m[1] ?? m[2]!)).replace(/\.js$/, ".ts");
      const top = from.split("/")[0]!;
      const toActor = actorOf(to);
      let rule: string | null = null;
      if (LIBRARIES.includes(top) && (to.startsWith("actors/") || to.startsWith("http/"))) rule = "library imports an actor or a route";
      else if (top === "actors" && to.startsWith("http/")) rule = "actor imports a route";
      else if (toActor && toActor !== actorOf(from) && !to.endsWith("/contract.ts") && !(ENTRIES.includes(from) && to.endsWith("/durable-object.ts")))
        rule = "reaches into an actor past its contract";
      if (rule) out.push(`${from} -> ${to} (${rule})`);
    }
  }
  return [...new Set(out)].sort();
}

describe("import boundaries", () => {
  const found = violations();
  it("nothing new breaks them", () => {
    expect(found.filter((v) => !EXISTING.includes(v))).toEqual([]);
  });
  it("EXISTING lists only what still breaks them", () => {
    expect(EXISTING.filter((v) => !found.includes(v))).toEqual([]);
  });
});
