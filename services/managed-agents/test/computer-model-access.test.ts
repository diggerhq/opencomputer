import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { MODEL_ACCESS_UNAVAILABLE, noModelAccess } from "../src/computer/model-access.js";

/**
 * Work 097, 6b: the ModelAccess seam. The public build's `noModelAccess`
 * routes every session managed, connects nothing, and has no Slack
 * commands; and the hosted modules are reachable only through
 * model-access-impl.ts, which only the Durable Object imports.
 */

const SRC = join(__dirname, "..", "src");
const HOSTED = ["model-subscriptions", "model-subscriptions-store", "model-subscriptions-slack", "agent-connect", "connect-codes", "token-check"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
}

/** The module specifiers `file` imports or re-exports from. */
function importsOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gm)].map((m) => m[1]!);
}

describe("noModelAccess (the public build)", () => {
  const access = noModelAccess();

  it("routes every session on the managed models, as a member with no subscription", async () => {
    expect(await access.models.forDelivery({ key: "T:C:1", ownerId: "U1" }, "U1")).toEqual({ route: { mode: "managed" }, reason: "no_subscription" });
    expect(await access.models.forDelivery({ key: "T:C:1", ownerId: "U1" }, "U2", "wait")).toEqual({ route: { mode: "managed" }, reason: "no_subscription" });
    expect(access.models.hostReady()).toBe(false);
    expect(access.models.hostReady("chatgpt")).toBe(false);
    expect(access.models.probe("sk-ant-oat01-x")).toBeNull();
    expect(access.models.harness("T:C:1")).toBe("claude");
    expect(access.models.managedOnly("T:C:1")).toBe(false);
    expect(await access.models.isMember("U1")).toBe(false);
    expect(await access.models.helloed(["T:C:1"])).toBe(0);
  });

  it("connects nothing: 404 not_available wherever a result may say no", async () => {
    expect(await access.agents.connect("dash-1", "sk-ant-oat01-x")).toEqual({ ok: false, ...MODEL_ACCESS_UNAVAILABLE });
    expect(await access.agents.connectCodex("dash-1", "{}")).toEqual({ ok: false, status: 404, code: "not_available", message: expect.any(String) });
    expect(await access.codes.mint({ dashboard: "dash-1" }, "dashboard")).toEqual({ ok: false, ...MODEL_ACCESS_UNAVAILABLE });
    expect(await access.codes.redeem("oc_0000000000000000", { provider: "claude" })).toEqual({ ok: false, ...MODEL_ACCESS_UNAVAILABLE });
    expect(access.codes.refuse("unknown")).toEqual({ ok: false, ...MODEL_ACCESS_UNAVAILABLE });
    expect(await access.codes.link("oc_0000000000000000", "U1")).toEqual({ ok: false, reason: "unknown" });
    expect(access.agents.view("dash-1")).toEqual({ choice: null, linked: false, subscription: null, subscriptions: { claude: null, codex: null }, managedModel: expect.any(String), harnesses: ["claude"] });
    expect(await access.agents.resume("dash-1")).toEqual(access.agents.view("dash-1"));
    expect(access.agents.needsLink("dash-1")).toBe(false);
    expect(access.agents.linkOfSlack("U1")).toBeUndefined();
    expect(access.agents.harnessFor("U1")).toEqual({ harness: "claude", via: "none" });
    expect(noModelAccess({ harnesses: () => ["claude", "codex"] }).agents.view("dash-1").harnesses).toEqual(["claude", "codex"]);
  });

  it("has no Slack commands", () => {
    expect(access.slack).toBeUndefined();
  });

  it("touches no storage: every method runs without a Durable Object", async () => {
    // The null implementation is built with no deps at all, so it has no SQL to touch; each method still answers.
    const m = access.models;
    m.setHarness("T:C:1", "codex");
    m.setHarness("T:C:1", null);
    m.probed("p1", { status: 200 }, undefined);
    m.noteSent("T:C:1", { mode: "managed" });
    await m.memberRemoved("U1");
    m.markManagedOnly("T:C:1");
    await m.health({ sessionKey: "T:C:1", provider: "anthropic", state: "ok" } as never);
    await m.expire();
    m.emit("subscription.probe" as never, {} as never);
    await m.denied("U1", "managed");
    m.bound("T:C:1", "managed", undefined);
    const a = access.agents;
    await a.unrekey("UI");
    a.setChoice("dash-1", "codex");
    await a.rekey("dash-1", "UI");
    await a.expire();
    await a.disconnect("dash-1");
    await a.disconnectCodex("dash-1");
    expect(a.view("dash-1").choice).toBeNull();
  });
});

describe("the seam", () => {
  const files = sourceFiles(SRC);
  const importers = (names: string[]) =>
    files
      .filter((file) => importsOf(file).some((spec) => names.some((name) => spec === `./${name}.js` || spec.endsWith(`/${name}.js`))))
      .map((file) => relative(SRC, file))
      .sort();

  it("only model-access-impl.ts imports the hosted modules (besides themselves)", () => {
    const outside = importers(HOSTED).filter((file) => !HOSTED.some((name) => file === `computer/${name}.ts`));
    expect(outside.filter((file) => file !== "computer/model-access-impl.ts")).toEqual([]);
  });

  it("only the Durable Object imports model-access-impl.ts", () => {
    expect(importers(["model-access-impl"])).toEqual(["computer/durable-object.ts"]);
  });

  it("the hosted modules do not import model-access-impl.ts", () => {
    // The public build has none of them (overlay/subscriptions.json).
    for (const file of HOSTED.map((name) => join(SRC, "computer", `${name}.ts`)).filter((file) => existsSync(file))) {
      expect(importsOf(file)).not.toContain("./model-access-impl.js");
    }
  });
});
