import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createViaCell, __resetCreateBatchState } from "./create_batch";

const BASE = "https://cp.example.com";
const TOKEN = "tok-a";
/** Captured before any test stubs setTimeout, so a stub can still schedule. */
const realSetTimeout = globalThis.setTimeout;

interface Sent {
  url: string;
  auth: string;
  body: string;
}

/**
 * Stands in for the control plane. `hold` lets a test keep creates in flight,
 * which is the only way to reach the batching path: a create with nothing else
 * outstanding is deliberately sent alone.
 */
function installFetch(opts: {
  hold?: Promise<void>;
  batchStatus?: number;
  batchBody?: (items: unknown[]) => unknown;
}): { sent: Sent[] } {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const body = String(init.body);
    sent.push({ url, auth: String((init.headers as Record<string, string>).authorization), body });
    if (url.endsWith("/create-batch")) {
      if (opts.hold) await opts.hold;
      const status = opts.batchStatus ?? 200;
      if (status !== 200) return new Response("nope", { status });
      const items = (JSON.parse(body) as { items: unknown[] }).items;
      const payload = opts.batchBody
        ? opts.batchBody(items)
        : { results: items.map((it) => ({ status: 201, body: { echo: it } })) };
      return new Response(JSON.stringify(payload), { status: 200 });
    }
    if (opts.hold) await opts.hold;
    // Tolerant of a non-JSON body: one test deliberately sends one.
    let echo: unknown = body;
    try {
      echo = JSON.parse(body || "{}");
    } catch {
      /* keep the raw text */
    }
    return new Response(JSON.stringify({ echo }), { status: 201 });
  });
  return { sent };
}

beforeEach(() => __resetCreateBatchState());
afterEach(() => vi.unstubAllGlobals());

describe("createViaCell", () => {
  // Sequential traffic is already fast and has nobody to batch with. If it ever
  // starts paying a coalescing window, this fix has made the common case worse.
  it("sends a lone create immediately and unbatched", async () => {
    const { sent } = installFetch({});
    const r = await createViaCell(BASE, TOKEN, '{"n":1}', true);
    expect(r.batched).toBe(false);
    expect(r.batchSize).toBe(1);
    expect(r.waitMs).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(BASE + "/internal/sandboxes/create");
  });

  // The whole point: N concurrent creates cost ONE connection, not N.
  it("coalesces concurrent creates into a single request", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const { sent } = installFetch({ hold });

    const first = createViaCell(BASE, TOKEN, '{"n":0}', true);
    const rest = Array.from({ length: 20 }, (_, i) => createViaCell(BASE, TOKEN, `{"n":${i + 1}}`, true));
    await vi.waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(2));
    release();
    const results = await Promise.all([first, ...rest]);

    // One lone create (it arrived first, with nothing in flight) plus exactly one
    // batch carrying the other twenty.
    expect(sent.filter((s) => s.url.endsWith("/create-batch"))).toHaveLength(1);
    expect(sent.filter((s) => s.url.endsWith("/sandboxes/create"))).toHaveLength(1);
    expect(results.filter((r) => r.batched)).toHaveLength(20);
    expect(results[1].batchSize).toBe(20);
  });

  // Results are positional. A shuffle hands caller A the sandbox caller B asked
  // for — silently, and with no error anywhere.
  it("returns each waiter its own result", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const { sent } = installFetch({ hold });

    const first = createViaCell(BASE, TOKEN, '{"n":0}', true);
    const rest = Array.from({ length: 10 }, (_, i) => createViaCell(BASE, TOKEN, `{"n":${i + 1}}`, true));
    await vi.waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(2));
    release();
    const results = await Promise.all([first, ...rest]);

    results.forEach((r, i) => {
      expect(JSON.parse(r.text).echo).toEqual({ n: i });
    });
  });

  // The CP verifies the cap-token ONCE and every item in the batch inherits
  // those claims. Two callers sharing a request would mean one org's create
  // authorized by another org's token.
  it("never batches creates carrying different cap-tokens", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const { sent } = installFetch({ hold });

    // n=0 arrives with nothing in flight and so goes out alone; the rest split
    // into one batch per token.
    const all = [
      createViaCell(BASE, "tok-a", '{"n":0}', true),
      createViaCell(BASE, "tok-a", '{"n":1}', true),
      createViaCell(BASE, "tok-a", '{"n":2}', true),
      createViaCell(BASE, "tok-b", '{"n":3}', true),
      createViaCell(BASE, "tok-b", '{"n":4}', true),
    ];
    await vi.waitFor(() => expect(sent.filter((s) => s.url.endsWith("/create-batch")).length).toBe(2));
    release();
    await Promise.all(all);

    for (const s of sent.filter((s) => s.url.endsWith("/create-batch"))) {
      const items = (JSON.parse(s.body) as { items: { n: number }[] }).items;
      const expected = s.auth === "Bearer tok-a" ? [1, 2] : [3, 4];
      expect(items.map((i) => i.n).sort()).toEqual(expected);
    }
  });

  // A failing envelope says nothing about the individual creates — none of them
  // ran. Every waiter must still get a real sandbox.
  it("falls back to single creates when the batch request fails", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const { sent } = installFetch({ hold, batchStatus: 500 });

    const first = createViaCell(BASE, TOKEN, '{"n":0}', true);
    const rest = Array.from({ length: 5 }, (_, i) => createViaCell(BASE, TOKEN, `{"n":${i + 1}}`, true));
    await vi.waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(2));
    release();
    const results = await Promise.all([first, ...rest]);

    expect(results.every((r) => r.status === 201)).toBe(true);
    results.forEach((r, i) => expect(JSON.parse(r.text).echo).toEqual({ n: i }));
    expect(sent.filter((s) => s.url.endsWith("/sandboxes/create"))).toHaveLength(6);
  });

  // A result count that does not match the item count means we cannot tell whose
  // sandbox is whose. Guessing is worse than redoing the work.
  it("discards a mismatched result set rather than guessing", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const { sent } = installFetch({ hold, batchBody: () => ({ results: [{ status: 201, body: {} }] }) });

    const first = createViaCell(BASE, TOKEN, '{"n":0}', true);
    const rest = Array.from({ length: 4 }, (_, i) => createViaCell(BASE, TOKEN, `{"n":${i + 1}}`, true));
    await vi.waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(2));
    release();
    const results = await Promise.all([first, ...rest]);

    results.forEach((r, i) => expect(JSON.parse(r.text).echo).toEqual({ n: i }));
  });

  // A control plane that predates the endpoint must not make every burst pay a
  // doomed batch on top of the fallback.
  it("stops batching after the endpoint 404s", async () => {
    let release!: () => void;
    let hold = new Promise<void>((r) => (release = r));
    const { sent } = installFetch({ hold, batchStatus: 404 });

    const burst = async (): Promise<void> => {
      const first = createViaCell(BASE, TOKEN, '{"n":0}', true);
      const rest = Array.from({ length: 3 }, (_, i) => createViaCell(BASE, TOKEN, `{"n":${i + 1}}`, true));
      await vi.waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(2));
      release();
      await Promise.all([first, ...rest]);
    };

    await burst();
    expect(sent.filter((s) => s.url.endsWith("/create-batch"))).toHaveLength(1);

    hold = new Promise<void>((r) => (release = r));
    release();
    await burst();
    // Still one: the second burst never attempted the endpoint again.
    expect(sent.filter((s) => s.url.endsWith("/create-batch"))).toHaveLength(1);
  });

  // The failure that took 18% of a burst-100 to HTTP 500 on dev: the request
  // owning a batch dies, so its timer never fires and its waiters are never
  // resolved. The Workers runtime then cancels every one of them as hung. No
  // waiter may depend on another request surviving — each must be able to
  // answer on its own.
  it("still answers every waiter when the batch never dispatches", async () => {
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      sent.push(url);
      return new Response(JSON.stringify({ echo: JSON.parse(String(init.body) || "{}") }), { status: 201 });
    });
    // Simulate the dead owner: the window timer is armed but never runs.
    vi.stubGlobal("setTimeout", ((fn: () => void, ms?: number) => {
      // Only the batch window is suppressed; each waiter's own deadline must
      // still fire, or this test would prove nothing.
      if (ms === 5) return 0 as unknown as ReturnType<typeof setTimeout>;
      return realSetTimeout(fn, ms);
    }) as typeof setTimeout);

    const first = createViaCell(BASE, TOKEN, '{"n":0}', true);
    const rest = Array.from({ length: 5 }, (_, i) => createViaCell(BASE, TOKEN, `{"n":${i + 1}}`, true));
    const results = await Promise.all([first, ...rest]);

    // Every waiter got a real create rather than hanging forever.
    expect(results).toHaveLength(6);
    results.forEach((r, i) => {
      expect(r.status).toBe(201);
      expect(JSON.parse(r.text).echo).toEqual({ n: i });
    });
    expect(sent.filter((u) => u.endsWith("/create-batch"))).toHaveLength(0);
  });

  // Item bodies are spliced into the envelope as raw JSON to stay byte-identical
  // to a single create. A body that is not a JSON object would corrupt every
  // other item in the batch, not just its own.
  it("sends an unparseable body on its own", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const { sent } = installFetch({ hold });

    const first = createViaCell(BASE, TOKEN, '{"n":0}', true);
    const bad = createViaCell(BASE, TOKEN, "not json at all", true);
    await vi.waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(2));
    release();
    await Promise.all([first, bad]);

    expect(sent.filter((s) => s.url.endsWith("/create-batch"))).toHaveLength(0);
    expect(sent.filter((s) => s.url.endsWith("/sandboxes/create"))).toHaveLength(2);
  });
});
