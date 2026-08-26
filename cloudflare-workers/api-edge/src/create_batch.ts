// create_batch.ts — collapse a burst of concurrent creates into ONE request to
// the control plane.
//
// STATUS: BUILT, MEASURED, FALSIFIED. Gated behind the CREATE_BATCH env and
// DEFAULT OFF. Keep it that way unless something below changes.
//
// The hypothesis in "WHY" was tested on dev and did not survive. Coalescing
// worked exactly as designed — `cellbatch` p50 was 26 creates per request — and
// bought nothing: the `cell` mark was 132ms batched vs 126ms for a lone create.
// 26x fewer connections, no improvement, so the edge→cell hop is round-trip
// bound rather than connection bound. The burst cost turned out to be time spent
// queued BEFORE our handler is given a CPU, which no amount of batching touches.
//
// It is kept rather than deleted for two reasons: the CP endpoint is harmless
// and already deployed, and the "SURVIVING THE OWNER" section below documents a
// Workers constraint that cost us 18% of a burst to learn and that applies to
// any future cross-request coalescing.
//
// WHY (the original hypothesis — recorded because it was wrong, not because it
// was right). A burst of 100 creates costs ~115ms each in the create handler's `cell`
// mark while the CP answers every one of them in ~59us. Practically none of that
// hop is work: it is the connection. `cp-uswest2.opensandbox.ai` resolves to an
// Azure address that is NOT behind Cloudflare's proxy, so a Worker subrequest
// dials it directly and a concurrent burst opens a pile of fresh connections,
// each paying a TLS handshake to westus2. The same hop served serially is ~30ms
// — one warm connection, one round trip.
//
// The protocol knob that would fix this is not available to us: `fetch()` in a
// Worker exposes no way to force HTTP/2, and the zone-level "HTTP/2 to Origin"
// setting only applies to proxied hostnames, which this origin is not. So the
// only reliable way to stop paying ~100 handshakes is to stop making ~100
// requests. The CP side is POST /internal/sandboxes/create-batch.
//
// WHEN IT ENGAGES. A fixed coalescing window would tax every create, including
// the sequential ones that are already fast (~194ms end to end) and have nobody
// to batch with. So batching is gated on observed concurrency instead: a create
// that arrives when this isolate has none in flight is alone by definition and
// goes straight out, unchanged and undelayed. Only a create that arrives while
// another is already in flight joins a batch. Sequential traffic therefore never
// pays the window, and a burst self-clocks into it — the first create leaves
// immediately and its neighbours accumulate behind it.
//
// Coalescing is per-isolate on purpose. It needs no Durable Object, no shard
// map, and no cross-isolate coordination: an isolate can only batch requests it
// is already holding. If a burst spreads across several isolates each one
// batches its own share, which is a smaller win but never a wrong one.
//
// SURVIVING THE OWNER. Batching means one request's work answers several
// requests, and the Workers runtime is unforgiving about that: it cancels any
// request it decides "had hung and would never generate a response". A waiter
// whose result depends entirely on ANOTHER request's timer and fetch has no
// pending I/O of its own, so if that other request dies — cancelled client,
// abandoned connection, anything — its timer never fires, its waiters are never
// resolved, and the runtime kills every one of them. Measured on dev at
// burst-100: 18% of creates returned HTTP 500 (Cloudflare error 1101) that way,
// while burst-30 was clean, because one dead request takes its whole batch with
// it and bursts produce more of them.
//
// So no waiter may depend on another request surviving. Each one arms its own
// deadline in its own context and, if the batch has not answered by then, does
// its own single create. The batch becomes an optimisation that can fail
// silently instead of a shared point of failure.

import type { CreateCallResult } from "./create_batch_types";

// The window only ever delays a create that already has a peer in flight, so it
// trades a few ms of that create's latency for the whole burst's handshakes.
const BATCH_WINDOW_MS = 5;

// Mirrors maxBatchItems on the CP. Reaching it flushes early rather than
// truncating: no create is ever silently dropped from a batch.
const BATCH_MAX_ITEMS = 256;

// How long to stop trying after the CP rejects the endpoint itself (404/405 =
// a control plane that predates this). Without it every burst would pay a
// failed batch plus the full fallback, which is strictly worse than not
// batching at all.
const BATCH_DISABLE_MS = 60_000;

// How long a waiter will trust the batch before doing the work itself. Well
// clear of a healthy batch round trip (~30-130ms to the cell), so in normal
// operation this never fires; it exists so that a batch whose owning request
// died cannot hang anyone. The cost of it firing is one ordinary create.
const WAITER_DEADLINE_MS = 400;

interface Waiter {
  /** The exact bytes a single create would have sent. */
  body: string;
  resolve: (r: CreateCallResult) => void;
  reject: (e: unknown) => void;
  queuedAt: number;
  /**
   * Set once this waiter has an answer, from whichever path got there first.
   * The batch and the waiter's own deadline race, and both must be harmless
   * after the other has won.
   */
  settled: boolean;
}

interface OpenBatch {
  cellBase: string;
  capToken: string;
  waiters: Waiter[];
  timer: ReturnType<typeof setTimeout> | null;
}

const openBatches = new Map<string, OpenBatch>();

/** Creates this isolate is currently holding — the concurrency signal. */
let createsInFlight = 0;

/** Set when the CP tells us the batch endpoint does not exist. */
let batchDisabledUntil = 0;

/**
 * postCreate issues one ordinary single create, exactly as the handler did
 * before batching existed. Every fallback in this module lands here, so a
 * degraded batch path is never worse than no batch path.
 */
async function postCreate(cellBase: string, capToken: string, body: string): Promise<CreateCallResult> {
  const resp = await fetch(cellBase.replace(/\/$/, "") + "/internal/sandboxes/create", {
    method: "POST",
    headers: { authorization: "Bearer " + capToken, "content-type": "application/json" },
    body: body || "{}",
  });
  return { status: resp.status, text: await resp.text(), batched: false, batchSize: 1, waitMs: 0 };
}

/**
 * createViaCell is the entry point the create handler calls in place of its
 * direct fetch. It either sends immediately (nothing else in flight) or joins
 * the batch forming for this exact destination.
 */
export function createViaCell(
  cellBase: string,
  capToken: string,
  body: string,
  // Off unless the deployment turns it on. Measured on dev 2026-08-26 with a
  // settled 100/100 pool: coalescing worked (26 creates per request, p50) and
  // bought nothing — `cell` was 132ms batched vs 126ms for a lone create. That
  // says the edge->cell hop is not connection-bound after all; a batch of 26
  // just costs what the slowest of 26 pool claims costs. Kept behind a flag
  // rather than deleted so the A/B is one env change, not a redeploy.
  enabled: boolean,
): Promise<CreateCallResult> {
  createsInFlight++;
  const alone = createsInFlight === 1;
  const done = (): void => {
    createsInFlight--;
  };

  // Disabled, nothing else in flight, endpoint missing, or a body we could not
  // validate: take the untouched single-create path.
  if (!enabled || alone || Date.now() < batchDisabledUntil || !isJSONObject(body)) {
    return postCreate(cellBase, capToken, body).finally(done);
  }

  // The cap-token is the batch key, not just part of it. The CP verifies the
  // token ONCE for the batch and every item inherits those claims, so two
  // creates may only share a request if they would have presented byte-identical
  // credentials. Keying on the token makes that structural: a different org,
  // user, plan, runtime, or cell cannot land in the same batch.
  const key = cellBase + " " + capToken;

  let self: Waiter;
  const joined = new Promise<CreateCallResult>((resolve, reject) => {
    let batch = openBatches.get(key);
    if (!batch) {
      batch = { cellBase, capToken, waiters: [], timer: null };
      openBatches.set(key, batch);
      batch.timer = setTimeout(() => {
        void flush(key);
      }, BATCH_WINDOW_MS);
    }
    self = { body, resolve, reject, queuedAt: Date.now(), settled: false };
    batch.waiters.push(self);
    if (batch.waiters.length >= BATCH_MAX_ITEMS) void flush(key);
  });

  // The waiter's own timer, armed in the waiter's own request context. This is
  // what makes the batch non-fatal: whatever happens to the request that owns
  // the batch, this request still wakes up and still has work it can do.
  return withOwnDeadline(joined, () => {
    // Losing the race means the batch never answered — its owner is gone. Leave
    // the batch (if it has not dispatched, this also stops it creating a sandbox
    // nobody is waiting for) and do the create here, in this request's context.
    dropWaiter(key, self);
    console.error("create-batch: batch owner never answered, creating solo");
    return postCreate(cellBase, capToken, body);
  }).finally(done);
}

/**
 * withOwnDeadline resolves from `p` if it answers in time, otherwise from
 * `fallback` — with the timer living in the caller's own request context.
 */
async function withOwnDeadline(
  p: Promise<CreateCallResult>,
  fallback: () => Promise<CreateCallResult>,
): Promise<CreateCallResult> {
  const LATE = Symbol("late");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof LATE>((resolve) => {
    timer = setTimeout(() => resolve(LATE), WAITER_DEADLINE_MS);
  });
  try {
    const winner = await Promise.race([p, deadline]);
    if (winner !== LATE) return winner;
    return await fallback();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * dropWaiter removes a waiter from its batch if that batch has not dispatched
 * yet, so an abandoned waiter does not get a sandbox created for it that no one
 * will ever receive. A batch already on the wire cannot be recalled; that item's
 * result is simply discarded when it lands.
 */
function dropWaiter(key: string, w: Waiter): void {
  w.settled = true;
  const batch = openBatches.get(key);
  if (!batch) return;
  const i = batch.waiters.indexOf(w);
  if (i >= 0) batch.waiters.splice(i, 1);
  if (batch.waiters.length === 0) {
    if (batch.timer !== null) clearTimeout(batch.timer);
    openBatches.delete(key);
  }
}

/**
 * flush dispatches whatever has accumulated under `key`. It detaches the batch
 * from the map first, so creates arriving during the round trip start a fresh
 * one rather than joining a batch that is already on the wire.
 */
async function flush(key: string): Promise<void> {
  const batch = openBatches.get(key);
  if (!batch) return;
  openBatches.delete(key);
  if (batch.timer !== null) clearTimeout(batch.timer);

  const waiters = batch.waiters;
  // A batch of one is just a create wearing an envelope: send it as itself. This
  // is the common outcome when concurrency is low, and it keeps the near-idle
  // path free of any dependency on the batch endpoint.
  if (waiters.length === 1) {
    await settleIndividually(batch, waiters);
    return;
  }

  const started = Date.now();
  let results: unknown;
  try {
    const resp = await fetch(batch.cellBase.replace(/\/$/, "") + "/internal/sandboxes/create-batch", {
      method: "POST",
      headers: { authorization: "Bearer " + batch.capToken, "content-type": "application/json" },
      body: '{"items":[' + waiters.map((w) => w.body || "{}").join(",") + "]}",
    });
    if (resp.status === 404 || resp.status === 405) {
      // The control plane does not have the endpoint. Stop asking.
      batchDisabledUntil = Date.now() + BATCH_DISABLE_MS;
      console.log(`create-batch: endpoint absent on ${batch.cellBase} (${resp.status}), disabling for ${BATCH_DISABLE_MS}ms`);
      await settleIndividually(batch, waiters);
      return;
    }
    if (resp.status < 200 || resp.status >= 300) {
      // A failing envelope says nothing about the individual creates — none of
      // them ran. Retrying them singly is safe and is what would have happened
      // without batching.
      console.error(`create-batch: envelope status ${resp.status}, falling back to ${waiters.length} single creates`);
      await settleIndividually(batch, waiters);
      return;
    }
    results = ((await resp.json()) as { results?: unknown }).results;
  } catch (e) {
    console.error("create-batch: dispatch failed, falling back to single creates:", e);
    await settleIndividually(batch, waiters);
    return;
  }

  // Results are positional and the CP guarantees one per item. If that does not
  // hold we cannot tell whose sandbox is whose, and handing caller A the box
  // caller B asked for is far worse than being slow — so discard and redo.
  if (!Array.isArray(results) || results.length !== waiters.length) {
    console.error(`create-batch: got ${Array.isArray(results) ? results.length : "non-array"} results for ${waiters.length} items, falling back`);
    await settleIndividually(batch, waiters);
    return;
  }

  const elapsed = Date.now() - started;
  for (let i = 0; i < waiters.length; i++) {
    // Gave up while the batch was on the wire and is creating its own sandbox.
    // Its slot in the response is dead weight; dropping it is the only option,
    // since the create already happened at the cell.
    if (waiters[i].settled) continue;
    const r = results[i] as { status?: number; body?: unknown };
    waiters[i].settled = true;
    waiters[i].resolve({
      status: typeof r?.status === "number" ? r.status : 502,
      text: r?.body === undefined ? "{}" : JSON.stringify(r.body),
      batched: true,
      batchSize: waiters.length,
      waitMs: Date.now() - waiters[i].queuedAt - elapsed,
    });
  }
}

/** settleIndividually runs every waiter as its own single create. */
async function settleIndividually(batch: OpenBatch, waiters: Waiter[]): Promise<void> {
  await Promise.all(
    waiters.map(async (w) => {
      if (w.settled) return;
      try {
        const r = await postCreate(batch.cellBase, batch.capToken, w.body);
        if (w.settled) return;
        w.settled = true;
        w.resolve({ ...r, waitMs: Date.now() - w.queuedAt });
      } catch (e) {
        if (w.settled) return;
        w.settled = true;
        w.reject(e);
      }
    }),
  );
}

/**
 * isJSONObject guards the envelope. Item bodies are spliced in as raw JSON to
 * keep them byte-identical to what a single create would have carried, so a body
 * that is not a well-formed JSON object would corrupt the whole batch — not just
 * its own item. Anything unparseable goes out on its own instead.
 */
function isJSONObject(body: string): boolean {
  if (!body) return true; // empty body becomes "{}" downstream
  try {
    const v: unknown = JSON.parse(body);
    return typeof v === "object" && v !== null && !Array.isArray(v);
  } catch {
    return false;
  }
}

/** Test seam: reset module state between cases. */
export function __resetCreateBatchState(): void {
  openBatches.clear();
  createsInFlight = 0;
  batchDisabledUntil = 0;
}
