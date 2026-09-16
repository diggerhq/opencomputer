import { afterEach, describe, expect, it } from "vitest";
import { OpenComputer } from "./index.js";

// A fetch that behaves like a native one in workerd: it refuses to run with
// a receiver other than the global. Calling `this.doFetch(...)` on the client
// handed it the client as `this`, which is the "Illegal invocation" the
// Development proof P4 hit on the first request of a Worker without Node
// compatibility.
function receiverCheckingFetch(this: unknown, input: string | URL | Request): Promise<Response> {
  if (this !== undefined && this !== globalThis) {
    return Promise.reject(new TypeError("Illegal invocation"));
  }
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return Promise.resolve(Response.json({ events: [] }, { status: 200, headers: { "x-url": url } }));
}

describe("the transport's receiver", () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  it("calls an injected fetch as a plain function, not as a method of the client", async () => {
    const oc = new OpenComputer({ apiKey: "k", baseUrl: "https://example.invalid", fetch: receiverCheckingFetch as typeof fetch });
    await expect(oc.sessions.events.list("ses-1", { after: 0 })).resolves.toEqual([]);
  });

  it("calls the global fetch the same way when none is injected", async () => {
    globalThis.fetch = receiverCheckingFetch as typeof fetch;
    const oc = new OpenComputer({ apiKey: "k", baseUrl: "https://example.invalid" });
    await expect(oc.sessions.events.list("ses-1", { after: 0 })).resolves.toEqual([]);
  });
});
