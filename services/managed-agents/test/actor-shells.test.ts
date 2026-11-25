import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * Tracks and threads, migration `v8`: Org, Slack and Delivery exist as classes that answer 503,
 * so the migration deploys ahead of the change that fills them in.
 */

const namespaces = env as unknown as Record<"ORGS" | "SLACK" | "DELIVERY", DurableObjectNamespace>;

describe("the v8 shell actors", () => {
  it.each(["ORGS", "SLACK", "DELIVERY"] as const)("%s answers 503", async (binding) => {
    const response = await namespaces[binding].getByName("org_test").fetch("https://actor/anything");
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(await response.json()).toMatchObject({ error: { code: "unavailable", retryable: true } });
  });
});
