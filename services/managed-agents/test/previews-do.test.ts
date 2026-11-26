import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { PreviewDurableObject } from "../src/previews/durable-object.js";

const previews = (env as unknown as { PREVIEWS: DurableObjectNamespace<PreviewDurableObject> }).PREVIEWS;
const claim = { organizationId: "org_a", tunnelId: "6ff42ae2-765d-4adf-8112-31c55c1551ef", port: 5173, createdBy: "C1:1.2" };

describe("PreviewDurableObject", () => {
  it("gives a name to exactly one of two organizations claiming it at once", async () => {
    const stub = previews.getByName("race");
    const results = await Promise.all([
      stub.claim("race", claim),
      stub.claim("race", { ...claim, organizationId: "org_b" }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, error: "name_taken" }]);
  });

  it("resolves, counts hits sparingly and releases only for its owner", async () => {
    const stub = previews.getByName("lifecycle");
    expect(await stub.resolve()).toEqual({ state: "free" });
    const claimed = await stub.claim("lifecycle", claim);
    if (!claimed.ok) throw new Error("claim refused");
    expect(await stub.resolve()).toEqual({ state: "live", record: claimed.record });

    await stub.hit(claimed.record.lastHitAt + 1_000);
    expect((await stub.resolve()) as { record: { lastHitAt: number } }).toMatchObject({ record: { lastHitAt: claimed.record.lastHitAt } });
    await stub.hit(claimed.record.lastHitAt + 31_000);
    expect(await stub.resolve()).toMatchObject({ record: { lastHitAt: claimed.record.lastHitAt + 31_000 } });

    expect(await stub.release("org_b")).toBe(false);
    expect(await stub.release("org_a")).toBe(true);
    expect(await stub.resolve()).toEqual({ state: "free" });
  });

  it("keeps a denied name unusable until allowed", async () => {
    const stub = previews.getByName("denied");
    await stub.claim("denied", claim);
    expect(await stub.deny()).toMatchObject({ organizationId: "org_a" });
    expect(await stub.resolve()).toEqual({ state: "denied" });
    expect(await stub.claim("denied", claim)).toEqual({ ok: false, error: "denied" });
    await stub.allow();
    expect(await stub.resolve()).toEqual({ state: "free" });
    expect(await stub.claim("denied", claim)).toMatchObject({ ok: true });
  });
});

describe("the previews Worker", () => {
  it("answers an unknown name with the unavailable page", async () => {
    const { SELF } = await import("cloudflare:test");
    const response = await SELF.fetch("https://nobody-here.opencomputer.app/");
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("not available");
  });
});
