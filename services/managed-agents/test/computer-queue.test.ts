import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { ComputerDurableObject } from "../src/computer/durable-object.js";
import { SLACK_STRANDED_GRACE_MS } from "../src/computer/durable-object.js";
import { hostToken } from "../src/computer/host-token.js";

/**
 * The Slack queue (work 068 §3a–3c): an accept drains it inline, with the
 * alarm as the fallback; one serial chain per thread, threads in parallel;
 * rows an evicted drain left `running` are recovered; the alarm runs the
 * queue before anything else. Each test has its own organization.
 */

const ORIGIN = "https://managedagents.test";
const KEY = "test-computer-host-token-key";

type Stub = DurableObjectStub<ComputerDurableObject>;
const computers = () => (env as unknown as { COMPUTERS: DurableObjectNamespace<ComputerDurableObject> }).COMPUTERS;
const inside = <T,>(stub: Stub, fn: (instance: any, state: DurableObjectState) => T) => runInDurableObject(stub, fn as never) as Promise<T>;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(read: () => T | Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
  for (let i = 0; i < 150; i += 1) {
    const value = await read();
    if (done(value)) return value;
    await sleep(20);
  }
  throw new Error(`${what} not reached`);
}

/** A linked organization with a connected host; every frame the host gets is collected. */
async function organization(org: string, team: string): Promise<{ stub: Stub; frames: any[]; socket: WebSocket }> {
  await computers().getByName(`computer-slack-team:${team}`).claimTeam(team, org);
  const stub = computers().getByName(org);
  await stub.linkSlack(org, { teamId: team, teamName: "Queue", botUserId: "UBOTQ", botToken: "xoxb-queue-token" });
  // The owners are known people: no name lookup on the path in these tests.
  await inside(stub, (_instance, state) => {
    for (const id of ["U1", "U2"]) {
      state.storage.sql.exec(
        "INSERT OR IGNORE INTO people (slack_user_id, dir, git_name, git_email, updated_at) VALUES (?, ?, ?, ?, ?)",
        id,
        `slack-${id.toLowerCase()}`,
        `Person ${id} via Computer`,
        `${id.toLowerCase()}@example.com`,
        Date.now(),
      );
    }
  });
  const upgraded = await SELF.fetch(`${ORIGIN}/v1/computer/host?organizationId=${org}`, {
    headers: { upgrade: "websocket", authorization: `Bearer ${await hostToken(KEY, org)}` },
  });
  const socket = upgraded.webSocket!;
  socket.accept();
  const frames: any[] = [];
  socket.addEventListener("message", (event) => frames.push(JSON.parse(String(event.data))));
  socket.send(JSON.stringify({ t: "hello", protocol: 1, hostId: org, version: "test", sessions: [] }));
  await until(() => frames, (all) => all.some((frame) => frame.t === "welcome"), "welcome");
  return { stub, frames, socket };
}

/** How each job was taken (`queue.started`'s `inline` and `parallel`), by message ts, recorded from the telemetry seam. */
async function recordTaken(stub: Stub): Promise<void> {
  await inside(stub, (instance) => {
    instance.taken = {};
    const real = instance.telemetry.dequeued.bind(instance.telemetry);
    instance.telemetry.dequeued = (payload: string, attempt: number, how: { inline: boolean; parallel: number }) => {
      instance.taken[JSON.parse(payload).messageTs] = how;
      return real(payload, attempt, how);
    };
  });
}
const taken = (stub: Stub) => inside(stub, (instance) => instance.taken as Record<string, { inline: boolean; parallel: number }>);

function job(team: string, channelId: string, threadTs: string, messageTs: string, text = "<@UBOTQ> go", userId = "U1") {
  return { eventId: `Ev-${channelId}-${messageTs}`, teamId: team, channelId, threadTs, messageTs, userId, text, mentioned: true, receivedAt: Date.now() };
}

const delivered = (frames: any[]) => frames.filter((frame) => frame.t === "deliver").map((frame) => `${frame.session.threadTs}/${frame.msg.ts}`);
const queueRows = (stub: Stub) =>
  inside(stub, (_instance, state) => [
    ...state.storage.sql.exec<{ sequence: number; state: string; attempts: number }>("SELECT sequence, state, attempts FROM slack_queue ORDER BY sequence"),
  ]);

/**
 * Billing's admission held per thread until released; other threads are
 * admitted at once. Polled, not a resolver: a promise resolved from another
 * request's context would not wake the drain's.
 */
async function holdAdmission(stub: Stub, threads: string[]): Promise<void> {
  await inside(stub, (instance) => {
    const held = new Set(threads);
    instance.admissionReleased = false;
    instance.releaseAdmission = () => (instance.admissionReleased = true);
    instance.admitWith = async (_t: unknown, _channelId: string, threadTs: string) => {
      while (held.has(threadTs) && !instance.admissionReleased) await sleep(10);
      return true;
    };
  });
}

describe("the Slack queue", () => {
  it("keeps the chosen harness and stripped prefix when the first delivery is retried", async () => {
    const { stub, socket } = await organization("org_prefix_retry", "T0PREFIXRETRY");
    await inside(stub, (instance) => {
      instance.prefixDeliveries = [];
      instance.prefixFailed = false;
      instance.access.agents.harnessFor = () => ({ harness: "codex", via: "choice" });
      instance.deliver = async (dispatch: any) => {
        if (!instance.prefixFailed) {
          instance.prefixFailed = true;
          throw new Error("retry this delivery");
        }
        instance.prefixDeliveries.push({ text: dispatch.text, harness: instance.access.models.harness("T0PREFIXRETRY:C1:12.1") });
      };
    });
    await stub.acceptSlackEvent("org_prefix_retry", job("T0PREFIXRETRY", "C1", "12.1", "12.1", "<@UBOTQ> +claude +smart retry"));
    await until(() => queueRows(stub), (rows) => rows[0]?.state === "pending", "failed delivery queued");
    await inside(stub, (_instance, state) => state.storage.sql.exec("UPDATE slack_queue SET available_at = 0"));
    await runDurableObjectAlarm(stub);
    await until(() => inside(stub, (instance) => instance.prefixDeliveries), (all) => all.length === 1, "retried delivery");
    expect(await inside(stub, (instance) => instance.prefixDeliveries)).toEqual([{ text: "+smart retry", harness: "claude" }]);
    socket.close();
  });

  it("sends inline on accept, without an alarm firing, and leaves the alarm nothing to do", async () => {
    const { stub, frames, socket } = await organization("org_q_inline", "T0QINLINE");
    await recordTaken(stub);
    expect(await stub.acceptSlackEvent("org_q_inline", job("T0QINLINE", "C1", "10.1", "10.1"))).toEqual({ accepted: true });
    // No runDurableObjectAlarm here: the accept's own drain sent it.
    await until(() => delivered(frames), (all) => all.length === 1, "the inline delivery");
    expect(delivered(frames)).toEqual(["10.1/10.1"]);
    expect(await queueRows(stub)).toEqual([]);
    expect(await taken(stub)).toEqual({ "10.1": { inline: true, parallel: 1 } });
    // The fallback alarm is taken off once the queue is empty (nothing else is due for this object).
    await until(() => inside(stub, (_instance, state) => state.storage.getAlarm()), (at) => at === null, "the alarm cleared");
    expect(await inside(stub, (_instance, state) => [...state.storage.sql.exec("SELECT purpose FROM alarms")])).toEqual([]);
    // Fired anyway, it finds nothing and sends nothing again.
    await inside(stub, (_instance, state) => state.storage.setAlarm(Date.now()));
    await runDurableObjectAlarm(stub);
    await sleep(50);
    expect(delivered(frames)).toEqual(["10.1/10.1"]);
    socket.close();
  });

  it("never sends twice when accepts and the alarm overlap a drain, and keeps a thread's order", async () => {
    const { stub, frames, socket } = await organization("org_q_overlap", "T0QOVER");
    await recordTaken(stub);
    await holdAdmission(stub, ["20.1"]);
    // The first message's drain waits on billing; the second, same thread, joins it.
    await stub.acceptSlackEvent("org_q_overlap", job("T0QOVER", "C1", "20.1", "20.1"));
    await stub.acceptSlackEvent("org_q_overlap", job("T0QOVER", "C1", "20.1", "20.2", "and this"));
    expect((await queueRows(stub)).map((row) => row.state)).toEqual(["running", "pending"]);
    // The alarm arrives meanwhile: it neither starts a second drain nor waits out the one in
    // flight (the other purposes must not wait on billing); it comes back later for it.
    await inside(stub, (_instance, state) => state.storage.sql.exec("UPDATE alarms SET at = 0"));
    await runDurableObjectAlarm(stub);
    expect(delivered(frames)).toEqual([]);
    const watchdog = await inside(stub, (_instance, state) => [...state.storage.sql.exec<{ at: number }>("SELECT at FROM alarms WHERE purpose = 'slack'")][0]?.at);
    expect(watchdog).toBeGreaterThan(Date.now() + 30_000);
    await inside(stub, (instance) => instance.releaseAdmission());
    await until(() => delivered(frames), (all) => all.length === 2, "both deliveries");
    await sleep(100);
    expect(delivered(frames)).toEqual(["20.1/20.1", "20.1/20.2"]);
    expect(await queueRows(stub)).toEqual([]);
    // Both were accepted here and taken by the drain, whichever woke it: inline.
    expect(await taken(stub)).toEqual({ "20.1": { inline: true, parallel: 1 }, "20.2": { inline: true, parallel: 1 } });
    // The watchdog went with the queue's last row.
    expect(await inside(stub, (_instance, state) => [...state.storage.sql.exec("SELECT purpose FROM alarms WHERE purpose = 'slack'")])).toEqual([]);
    socket.close();
  });

  it("does not hold one thread's message behind another thread's slow job", async () => {
    const { stub, frames, socket } = await organization("org_q_parallel", "T0QPAR");
    await holdAdmission(stub, ["30.1"]);
    await stub.acceptSlackEvent("org_q_parallel", job("T0QPAR", "C1", "30.1", "30.1"));
    await stub.acceptSlackEvent("org_q_parallel", job("T0QPAR", "C1", "30.1", "30.2", "behind it, same thread"));
    await stub.acceptSlackEvent("org_q_parallel", job("T0QPAR", "C2", "31.1", "31.1", "<@UBOTQ> other thread", "U2"));
    // Thread 31.1 goes while thread 30.1's first job still waits on billing; 30.2 waits behind 30.1.
    await until(() => delivered(frames), (all) => all.includes("31.1/31.1"), "the other thread's delivery");
    expect(delivered(frames)).toEqual(["31.1/31.1"]);
    await inside(stub, (instance) => instance.releaseAdmission());
    await until(() => delivered(frames), (all) => all.length === 3, "the slow thread's deliveries");
    expect(delivered(frames)).toEqual(["31.1/31.1", "30.1/30.1", "30.1/30.2"]);
    socket.close();
  });

  it("recovers rows an evicted drain left running: all of them on start, all but the youngest on an alarm", async () => {
    const { stub, frames, socket } = await organization("org_q_stranded", "T0QSTRAND");
    await recordTaken(stub);
    const payload = (ts: string) => JSON.stringify({ ...job("T0QSTRAND", "C1", ts, ts), text: "go" });
    await inside(stub, (_instance, state) => {
      const sql = state.storage.sql;
      // Evicted mid-job 20 s ago (one attempt spent), and one claimed just now, within the alarm's grace.
      sql.exec(
        "INSERT INTO slack_queue (payload, state, attempts, available_at, thread_key, started_at) VALUES (?, 'running', 1, 0, 'C1:40.1', ?)",
        payload("40.1"),
        Date.now() - 20_000,
      );
      sql.exec(
        "INSERT INTO slack_queue (payload, state, attempts, available_at, thread_key, started_at) VALUES (?, 'running', 1, 0, 'C1:40.2', ?)",
        payload("40.2"),
        Date.now() - 1_000,
      );
      // A row from before the column: no started_at, and no drain of this instance holds it.
      sql.exec("INSERT INTO slack_queue (payload, state, attempts, available_at) VALUES (?, 'running', 2, 0)", payload("40.3"));
    });
    // A row this instance is processing right now is never taken from it, however old.
    await inside(stub, (instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO slack_queue (payload, state, attempts, available_at, thread_key, started_at) VALUES (?, 'running', 1, 0, 'C1:40.4', ?)",
        payload("40.4"),
        Date.now() - 120_000,
      );
      const sequence = [...state.storage.sql.exec<{ s: number }>("SELECT MAX(sequence) AS s FROM slack_queue")][0]!.s;
      instance.inFlight.add(sequence);
    });
    await inside(stub, (_instance, state) => state.storage.setAlarm(Date.now()));
    await runDurableObjectAlarm(stub);
    await until(() => delivered(frames), (all) => all.length === 2, "the recovered deliveries");
    await sleep(50);
    expect(delivered(frames).sort()).toEqual(["40.1/40.1", "40.3/40.3"]);
    // Recovered rows were not accepted by this instance: not inline.
    expect(await taken(stub)).toMatchObject({ "40.1": { inline: false }, "40.3": { inline: false } });
    const rows = await queueRows(stub);
    expect(rows.map((row) => row.state)).toEqual(["running", "running"]);
    // The young row is looked at again as soon as its grace is up, not a minute later.
    const slackAt = await inside(stub, (_instance, state) => [...state.storage.sql.exec<{ at: number }>("SELECT at FROM alarms WHERE purpose = 'slack'")][0]?.at);
    expect(slackAt).toBeLessThanOrEqual(Date.now() + SLACK_STRANDED_GRACE_MS);
    // On start (the constructor) nothing is in flight and no grace applies: every running row
    // is an evicted drain's. Attempts are kept: a recovered row's retry is its second.
    const recovered = await inside(stub, (instance) => {
      instance.inFlight.clear();
      return instance.recoverStrandedSlackJobs(0) as number;
    });
    expect(recovered).toBe(2);
    expect((await queueRows(stub)).map((row) => [row.state, row.attempts])).toEqual([
      ["pending", 1],
      ["pending", 1],
    ]);
    socket.close();
  });

  it("runs the Slack queue first on an alarm, and billing and size only after it", async () => {
    const stub = computers().getByName("org_q_order");
    const order = await inside(stub, async (instance, state) => {
      instance.bind("org_q_order");
      const order: string[] = [];
      const realDrain = instance.drain.bind(instance);
      instance.drain = (inline: boolean) => {
        order.push("slack:start");
        return realDrain(inline).then(async () => {
          await sleep(30);
          order.push("slack:end");
        });
      };
      instance.billingTick = async () => void order.push("billing");
      instance.reconcileSize = async () => void order.push("size");
      instance.lifecycle.tick = async () => void order.push("lifecycle");
      // Due in the order the old loop would have run them: billing and size before the queue.
      for (const purpose of ["billing", "size", "lifecycle", "slack"]) {
        state.storage.sql.exec("INSERT INTO alarms (purpose, at) VALUES (?, 0) ON CONFLICT(purpose) DO UPDATE SET at = 0", purpose);
      }
      await instance.alarm();
      await sleep(20);
      return order;
    });
    expect(order).toEqual(["slack:start", "slack:end", "lifecycle", "billing", "size"]);
  });

  it("looks at the size once more when a reconciliation is asked for while one runs", async () => {
    const stub = computers().getByName("org_q_reconcile");
    const runs = await inside(stub, async (instance) => {
      let runs = 0;
      instance.reconcileSizeOnce = async () => {
        runs += 1;
        await sleep(30);
      };
      // The second call (a hello's `size` alarm) joins the first, which may have read the row already.
      await Promise.all([instance.reconcileSize(), instance.reconcileSize()]);
      const afterTwo = runs;
      await instance.reconcileSize();
      return { afterTwo, afterThree: runs };
    });
    expect(runs).toEqual({ afterTwo: 2, afterThree: 3 });
  });

  it("keeps the unsealed credentials in memory until the bot token or model key changes", async () => {
    const { stub, socket } = await organization("org_q_creds", "T0QCREDS");
    const sizes = await inside(stub, async (instance) => {
      instance.unsealed.clear();
      await instance.credentials();
      const afterFirst = instance.unsealed.size;
      await instance.credentials();
      const afterSecond = instance.unsealed.size;
      return { afterFirst, afterSecond };
    });
    expect(sizes.afterFirst).toBeGreaterThan(0);
    expect(sizes.afterSecond).toBe(sizes.afterFirst);
    await stub.linkSlack("org_q_creds", { teamId: "T0QCREDS", teamName: "Queue", botUserId: "UBOTQ", botToken: "xoxb-queue-token-2" });
    const token = await inside(stub, async (instance) => (await instance.credentials()).slackBotToken as string);
    expect(token).toBe("xoxb-queue-token-2");
    socket.close();
  });
});

describe("a mention partway through a thread (work 049)", () => {
  /** Thread reads recorded instead of asking Slack: `read` answers with the thread above, `resolve` with no links. */
  async function fakeThreads(stub: Stub): Promise<void> {
    await inside(stub, (instance) => {
      instance.reads = [];
      instance.threads = () => ({
        read: async (ref: any, _audience: unknown, before?: string) => {
          instance.reads.push({ ref, before });
          return { url: "u", ok: true, where: "#eng", messages: [{ name: "ada", ts: ref.threadTs, text: "the export is broken" }] };
        },
        resolve: async () => [],
      });
    });
  }
  const reads = (stub: Stub) => inside(stub, (instance) => instance.reads as Array<{ ref: any; before?: string }>);

  it("starts the session with the replies above the mention, marked `here`", async () => {
    const { stub, frames, socket } = await organization("org_q_above", "T0QABOVE");
    await fakeThreads(stub);
    await stub.acceptSlackEvent("org_q_above", job("T0QABOVE", "C1", "20.1", "20.5"));
    const [frame] = await until(() => frames.filter((f) => f.t === "deliver"), (all) => all.length === 1, "the delivery");
    expect(await reads(stub)).toEqual([{ ref: { url: "", channel: "C1", ts: "20.5", threadTs: "20.1" }, before: "20.5" }]);
    expect(frame.msg.linked).toEqual([expect.objectContaining({ ok: true, here: true, where: "#eng" })]);
    // The next reply in that thread continues the session: nothing read again.
    await stub.acceptSlackEvent("org_q_above", job("T0QABOVE", "C1", "20.1", "20.6"));
    await until(() => delivered(frames), (all) => all.length === 2, "the second delivery");
    expect(await reads(stub)).toHaveLength(1);
    socket.close();
  });

  it("reads nothing for a mention that starts its own thread", async () => {
    const { stub, frames, socket } = await organization("org_q_top", "T0QTOP");
    await fakeThreads(stub);
    await stub.acceptSlackEvent("org_q_top", job("T0QTOP", "C1", "30.1", "30.1"));
    const [frame] = await until(() => frames.filter((f) => f.t === "deliver"), (all) => all.length === 1, "the delivery");
    expect(await reads(stub)).toEqual([]);
    expect(frame.msg.linked).toBeUndefined();
    socket.close();
  });
});
