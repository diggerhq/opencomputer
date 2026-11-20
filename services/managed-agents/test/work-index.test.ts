import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { DEFAULT_PAUSE_MS, REQUEST_TIMEOUT_MS, type TokenMinter } from "../src/computer/work/github.js";
import {
  ADVANCE_DETAILS,
  ALARM_EVERY_MS,
  FILL_BATCH,
  LOOK_AFTER_MS,
  PROBLEM_RETRY_MS,
  PULLS_EVERY_MS,
  PULLS_PER_QUERY,
  READ_WAIT_MS,
  RECENT_DAYS,
  UNREADABLE_RECHECK_MS,
  REPARSE_BATCH,
  BULK_ITEMS,
  BODY_STORE_BYTES,
  WorkIndex,
} from "../src/computer/work/index.js";
import type { IndexedItem, ItemsResult } from "../src/computer/work/index-contract.js";
import { PARSER_VERSION } from "../src/computer/work/item.js";
import type { IndexStore } from "../src/computer/work/platform.js";
import { sqlStorage } from "./fixtures/computer-sql.js";
import { FakeRepo } from "./fixtures/fake-github-repo.js";
import { FakeClock, indexStore } from "./fixtures/work-platform.js";

/** Work tracking 3.6: the Work index against a fake GitHub. */

const ORG = "acct_1";
const by = { member: "m_1", name: "Ana", email: "ana@acme.test" };

function setup(repo: FakeRepo, options: { sql?: SqlStorage; mint?: Partial<TokenMinter>; clock?: FakeClock; store?: (store: IndexStore) => IndexStore } = {}) {
  const clock = options.clock ?? new FakeClock();
  const pending: Promise<unknown>[] = [];
  const mints: unknown[] = [];
  let alarmAt: number | null = null;
  const sql = options.sql ?? sqlStorage();
  const account: TokenMinter = {
    async mintGitHubInstallationToken(input) {
      mints.push(input);
      return { outcome: "minted", token: "ghs_test", expiresAt: new Date(clock.now() + 3_600_000).toISOString() };
    },
    getGitHubInstallation: () => ({ accountLogin: "acme" }),
    listGitHubInstallations: () => [{ id: "12", githubInstallationId: 9012, accountLogin: "acme", accountType: "Organization", state: "active" }],
    ...options.mint,
  };
  const fetches: string[] = [];
  const index = new WorkIndex({
    store: options.store ? options.store(indexStore(sql)) : indexStore(sql),
    clock,
    scheduler: {
      arm: async (at) => {
        if (alarmAt === null || at < alarmAt) alarmAt = at;
      },
      waitUntil: (p) => void pending.push(p),
    },
    account: () => account,
    fetch: (url, init) => {
      fetches.push(url);
      return repo.fetch(url, init);
    },
  });
  const settle = async () => {
    while (pending.length) await Promise.allSettled(pending.splice(0));
  };
  return {
    index,
    sql,
    mints,
    clock,
    settle,
    tick: (ms: number) => clock.tick(ms),
    now: () => clock.now(),
    alarmAt: () => alarmAt,
    walkDone: () => index["walkDone"]() as boolean,
    /** Runs alarms until there is nothing more to do (or `max` runs). */
    async drain(max = 200) {
      for (let i = 0; i < max; i++) {
        const next = await index.alarm();
        await settle();
        if (next === null) return;
        if (next > clock.now()) clock.tick(next - clock.now());
        if (index["meta"]("build") === null && index["walkDone"]() && clock.now() - Number(index["meta"]("read_at")) > 10 * 60_000) return;
      }
    },
  };
}

const item = (n: number, title: string, extra = "") => `# ${n}. ${title}\n\nState of ${title}.\n${extra}`;

async function connect(repo: FakeRepo) {
  const s = setup(repo);
  const r = await s.index.setRepository(ORG, { installationId: "inst_1", owner: "ACME", name: "Knowledge" }, by);
  expect(r).toMatchObject({ ok: true, value: { installationId: "inst_1", owner: "acme", name: "knowledge", branch: "main", problem: null } });
  await s.settle();
  await s.drain();
  return s;
}

const open = async (s: ReturnType<typeof setup>) => {
  const r = await s.index.items(ORG, { stage: "open" });
  if (!r.ok) throw new Error("not ok");
  return r;
};
const itemOf = async (s: ReturnType<typeof setup>, n: number) => {
  const r = await s.index.item(ORG, n);
  if (!r.ok) throw new Error("unavailable");
  return r.item;
};
const byNumber = (r: ItemsResult & { ok: true }) => new Map<number, IndexedItem>(r.items.map((i) => [i.number, i]));

describe("build", () => {
  it("reads open items, gives closed ones a row from the listing, and reads those on demand", async () => {
    const repo = new FakeRepo({
      "work/1-board.md": item(1, "Board", "## Left\n- [x] a\n"),
      "work/2-api.md": item(2, "API"),
      "work/README.md": "not an item",
      "done/3-old-thing.md": item(3, "Old thing"),
      "notes/4-x.md": item(4, "Not tracked"),
    });
    const s = setup(repo);
    await s.index.setRepository(ORG, { installationId: "inst_1", owner: "acme", name: "knowledge" }, by);
    await s.settle();
    const r = await open(s);
    expect(r.head).toBe(repo.head);
    expect(r.building).toBe(false);
    expect(r.items.map((i) => [i.number, i.title, i.stateLine, i.readyToClose])).toEqual([
      [1, "Board", "State of Board.", true],
      [2, "API", "State of API.", false],
    ]);
    expect(r.items[0]!.url).toBe("https://github.com/acme/knowledge/blob/main/work/1-board.md");
    // Not dated until the walk reads the commits: null, never a guess.
    expect(r.items[0]!.updatedAt).toBeNull();
    // The token is narrowed to the repository, contents read.
    expect(s.mints[0]).toEqual({ installationId: "inst_1", permissions: { contents: "read" }, repositories: ["knowledge"] });

    // The build read the two open bodies only.
    expect(repo.take().filter((l) => l.includes("/git/blobs/"))).toHaveLength(2);
    const closed = await s.index.items(ORG, { stage: "closed" });
    expect(closed.ok && closed.items.map((i) => [i.number, i.title, i.parsed])).toEqual([[3, "Old thing", true]]);
    expect(repo.take().filter((l) => l.includes("/git/blobs/"))).toHaveLength(1);
  });

  it("reads open items in batches of 50 continued by the alarm, building until the last", async () => {
    const files: Record<string, string> = {};
    for (let n = 1; n <= FILL_BATCH + 5; n++) files[`work/${n}-item.md`] = item(n, `Item ${n}`);
    const repo = new FakeRepo(files);
    const s = setup(repo);
    await s.index.setRepository(ORG, { installationId: "inst_1", owner: "acme", name: "knowledge" }, by);
    await s.settle();
    let r = await open(s);
    expect(r.building).toBe(true);
    expect(r.items.filter((i) => i.parsed)).toHaveLength(FILL_BATCH);
    expect(r.items.find((i) => !i.parsed)!.title).toBe("item");
    expect(s.alarmAt()).not.toBeNull();
    s.tick(1000);
    await s.index.alarm();
    r = await open(s);
    expect(r.building).toBe(false);
    expect(r.items.every((i) => i.parsed)).toBe(true);
  });

  it("the walk recovers authors, created dates, links and close dates after a build", async () => {
    const repo = new FakeRepo({});
    repo.commit({ "work/1-a.md": item(1, "A") }, "Add 1\n\nSession: cs_one", { name: "Bob", email: "bob@acme.test" });
    repo.commit({ "work/2-b.md": item(2, "B") }, "Add 2", { name: "Cy via Computer", email: "cy@acme.test" });
    repo.commit({}, "Close 2", { name: "Cy via Computer", email: "cy@acme.test" }, { "work/2-b.md": "done/2-b.md" });
    const s = await connect(repo);
    s.tick(11 * 60_000);
    await s.drain();
    const one = (await itemOf(s, 1))!;
    expect(one.author).toEqual({ name: "Bob", email: "bob@acme.test" });
    expect(one.createdAt).toBe([...repo.commits.values()][1]!.at);
    expect(one.sessionIds).toEqual(["cs_one"]);
    const two = (await itemOf(s, 2))!;
    expect(two.stage).toBe("closed");
    expect(two.closedBy).toBe("Cy");
    expect(two.closedAt).toBe(repo.commits.get(repo.head!)!.at);
    expect(s.walkDone()).toBe(true);
  });
});

describe("activity and owners", () => {
  // The fake repository's commits start on 2026-11-01; the index's clock is set a day later.
  const early = () => new FakeClock(Date.parse("2026-11-02T00:00:00Z"));
  const bulk = (tag: string) => Object.fromEntries(Array.from({ length: BULK_ITEMS + 1 }, (_, i) => [`work/${i + 1}-x.md`, item(i + 1, `X ${i + 1}`, tag)]));

  it("an item's activity and derived owner are its latest commit touching at most five items; a bulk edit only moves updatedAt", async () => {
    const repo = new FakeRepo({});
    repo.commit(bulk("one"), "Import", { name: "Ana", email: "ana@acme.test" });
    repo.commit({ "work/1-x.md": item(1, "X 1", "two") }, "Edit 1", { name: "Bob via Computer", email: "Bob@Acme.test" });
    const own = repo.commits.get(repo.head!)!.at;
    repo.commit(bulk("three"), "Retag everything", { name: "Cy via Computer", email: "cy@acme.test" });
    const s = setup(repo, { clock: early() });
    await s.index.setRepository(ORG, { installationId: "inst_1", owner: "acme", name: "knowledge" }, by);
    await s.settle();
    await s.drain();
    s.tick(11 * 60_000);
    await s.drain();
    expect(s.walkDone()).toBe(true);
    const one = (await itemOf(s, 1))!;
    expect(one.updatedAt).toBe(repo.commits.get(repo.head!)!.at);
    expect(one.lastActivityAt).toBe(own);
    expect(one.owner).toEqual({ email: "bob@acme.test", name: "Bob", source: "derived" });
    expect(one.recent).toBe(true);
    // Touched only by bulk edits: no activity, and the latest commit's author as the owner.
    const two = (await itemOf(s, 2))!;
    expect(two.lastActivityAt).toBeNull();
    expect(two.recent).toBe(false);
    expect(two.owner).toEqual({ email: "cy@acme.test", name: "Cy", source: "derived" });
  });

  it("the frontmatter owner is declared and wins over commits", async () => {
    const repo = new FakeRepo({});
    repo.commit({ "work/1-a.md": `---\nowner: dee@acme.test\n---\n${item(1, "A")}` }, "Add 1", { name: "Bob", email: "bob@acme.test" });
    const s = setup(repo, { clock: early() });
    await s.index.setRepository(ORG, { installationId: "inst_1", owner: "acme", name: "knowledge" }, by);
    await s.settle();
    await s.drain();
    expect((await itemOf(s, 1))!.owner).toEqual({ email: "dee@acme.test", name: null, source: "declared" });
  });

  it("an advance sets activity from the compare's files; recent ages out after 14 days and the stamp counts it", async () => {
    const repo = new FakeRepo({ "work/1-a.md": item(1, "A"), "work/2-b.md": item(2, "B") });
    const s = setup(repo, { clock: early() });
    await s.index.setRepository(ORG, { installationId: "inst_1", owner: "acme", name: "knowledge" }, by);
    await s.settle();
    await s.drain();
    repo.commit({ "work/1-a.md": item(1, "A", "more") }, "Edit 1", { name: "Bob via Computer", email: "bob@acme.test" });
    await s.index.poke(ORG);
    await s.settle();
    const one = (await itemOf(s, 1))!;
    expect(one).toMatchObject({ lastActivityAt: repo.commits.get(repo.head!)!.at, recent: true, owner: { name: "Bob", source: "derived" } });
    const before = await s.index.stamp(ORG);
    expect(before.recent).toBeGreaterThanOrEqual(1);
    s.tick(RECENT_DAYS * 86_400_000);
    expect((await itemOf(s, 1))!.recent).toBe(false);
    const after = await s.index.stamp(ORG);
    expect(after.recent).toBe(0);
  });

  it("linked answers the items a session's id or key names, once each", async () => {
    const repo = new FakeRepo({ "work/1-a.md": item(1, "A"), "work/2-b.md": item(2, "B"), "work/3-c.md": item(3, "C") });
    const s = await connect(repo);
    repo.commit({ "work/1-a.md": item(1, "A", "x") }, "Edit 1\n\nSession: cs_1");
    repo.commit({ "work/2-b.md": item(2, "B", "x") }, "Edit 2\n\nSession: T1:C1:111");
    repo.commit({ "work/1-a.md": item(1, "A", "y") }, "Edit 1 again\n\nSession: T1:C1:111");
    await s.index.poke(ORG);
    await s.settle();
    s.tick(11 * 60_000);
    await s.drain();
    const r = await s.index.linked(ORG, ["cs_1", "T1:C1:111"]);
    expect(r.ok && r.items.map((i) => i.number)).toEqual([1, 2]);
    const none = await s.index.linked(ORG, ["cs_none"]);
    expect(none.ok && none.items).toEqual([]);
  });
});

describe("advance", () => {
  it("a push costs a head check, one compare and one blob", async () => {
    const repo = new FakeRepo({ "work/1-a.md": item(1, "A") });
    const s = await connect(repo);
    repo.take();
    repo.commit({ "work/1-a.md": item(1, "A renamed") }, "Edit 1", { name: "Bob", email: "bob@acme.test" });
    s.tick(LOOK_AFTER_MS + 1);
    await open(s);
    await s.settle();
    expect(repo.take().map((l) => l.split("?")[0]!.replace(/[0-9a-f]{40}/g, "SHA"))).toEqual([
      "GET /repos/acme/knowledge/git/ref/heads/main",
      "GET /repos/acme/knowledge/compare/SHA...SHA",
      "GET /repos/acme/knowledge/git/blobs/SHA",
    ]);
    const r = await open(s);
    expect(r.head).toBe(repo.head);
    expect(r.items[0]!.title).toBe("A renamed");
    expect(r.items[0]!.updatedAt).toBe(repo.commits.get(repo.head!)!.at);
  });

  it("an unchanged head is a 304 and nothing else; a fresh read does not look", async () => {
    const repo = new FakeRepo({ "work/1-a.md": item(1, "A") });
    const s = await connect(repo);
    s.tick(LOOK_AFTER_MS + 1);
    await open(s);
    await s.settle();
    repo.take();
    s.tick(LOOK_AFTER_MS + 1);
    const before = (await open(s)).asOf;
    await s.settle();
    expect(repo.take()).toEqual(["GET /repos/acme/knowledge/git/ref/heads/main"]);
    const after = (await open(s)).asOf;
    expect(Date.parse(after!)).toBeGreaterThan(Date.parse(before!));
    await open(s);
    await s.settle();
    expect(repo.take()).toEqual([]);
  });

  it("a move to done/ sets closedAt and closedBy from that commit, a move back clears them", async () => {
    const repo = new FakeRepo({ "work/1-a.md": item(1, "A"), "work/2-b.md": item(2, "B") });
    const s = await connect(repo);
    repo.commit({}, "Close 1", { name: "Bob via Computer", email: "bob@acme.test" }, { "work/1-a.md": "done/1-a.md" });
    await s.index.poke(ORG);
    await s.settle();
    let one = (await itemOf(s, 1))!;
    expect(one).toMatchObject({ stage: "closed", path: "done/1-a.md", closedBy: "Bob", closedAt: repo.commits.get(repo.head!)!.at, readyToClose: false });
    expect((await open(s)).items.map((i) => i.number)).toEqual([2]);
    // Two commits: a session closes 2 (no closer name), then 1 is reopened.
    repo.commit({}, "Close 2\n\nSession: cs_x", { name: "Cy", email: "cy@acme.test" }, { "work/2-b.md": "done/2-b.md" });
    repo.commit({}, "Reopen 1", { name: "Ana", email: "ana@acme.test" }, { "done/1-a.md": "work/1-a.md" });
    await s.index.poke(ORG);
    await s.settle();
    one = (await itemOf(s, 1))!;
    expect(one).toMatchObject({ stage: "open", closedAt: null, closedBy: null });
    const two = (await itemOf(s, 2))!;
    expect(two).toMatchObject({ stage: "closed", closedBy: null, sessionIds: ["cs_x"] });
    expect(two.closedAt).toBe([...repo.commits.values()].at(-2)!.at);
  });

  it("Session: trailers link: one commit uses the range's files, more ask each commit of the range once", async () => {
    const repo = new FakeRepo({ "work/1-a.md": item(1, "A"), "work/2-b.md": item(2, "B") });
    const s = await connect(repo);
    repo.take();
    repo.commit({ "work/1-a.md": item(1, "A", "more") }, "Edit\n\nSession: cs_1");
    await s.index.poke(ORG);
    await s.settle();
    expect(repo.take().some((l) => /\/commits\/[0-9a-f]{40}$/.test(l))).toBe(false);
    expect((await itemOf(s, 1))!.sessionIds).toEqual(["cs_1"]);

    repo.commit({ "work/2-b.md": item(2, "B", "x") }, "Edit 2\n\nSession: cs_2");
    repo.commit({ "work/1-a.md": item(1, "A", "y") }, "Edit 1 by hand");
    repo.take();
    await s.index.poke(ORG);
    await s.settle();
    expect(repo.take().filter((l) => /\/commits\/[0-9a-f]{40}$/.test(l))).toHaveLength(2);
    expect((await itemOf(s, 2))!.sessionIds).toEqual(["cs_2"]);
    expect((await itemOf(s, 1))!.sessionIds).toEqual(["cs_1"]);
  });

  it("an added item takes its author from the commit; a removed one loses its row and links", async () => {
    const repo = new FakeRepo({ "work/1-a.md": item(1, "A") });
    const s = await connect(repo);
    repo.commit({ "work/2-b.md": item(2, "B") }, "Add 2\n\nSession: cs_2", { name: "Bob", email: "bob@acme.test" });
    await s.index.poke(ORG);
    await s.settle();
    expect((await itemOf(s, 2))).toMatchObject({ author: { name: "Bob", email: "bob@acme.test" }, sessionIds: ["cs_2"] });
    repo.commit({ "work/2-b.md": null }, "Remove 2");
    await s.index.poke(ORG);
    await s.settle();
    expect((await itemOf(s, 2))).toBeNull();
    expect(s.sql.exec("SELECT * FROM links WHERE number = 2").toArray()).toEqual([]);
  });

  it("a rewritten history rebuilds, keeping links of the items that remain", async () => {
    const repo = new FakeRepo({ "work/1-a.md": item(1, "A"), "work/2-b.md": item(2, "B") });
    const s = await connect(repo);
    repo.commit({ "work/1-a.md": item(1, "A", "z") }, "Edit\n\nSession: cs_1");
    await s.index.poke(ORG);
    await s.settle();
    repo.forcePush({ "work/1-a.md": item(1, "A", "z"), "work/3-c.md": item(3, "C") });
    await s.index.poke(ORG);
    await s.settle();
    const r = await open(s);
    expect(r.head).toBe(repo.head);
    expect(r.items.map((i) => i.number)).toEqual([1, 3]);
    expect(byNumber(r).get(1)!.sessionIds).toEqual(["cs_1"]);
  });

  it("duplicate numbers: the open file wins, the other is a warning, and is promoted when the winner goes", async () => {
    const repo = new FakeRepo({ "work/5-new.md": item(5, "New"), "done/5-old.md": item(5, "Old") });
    const s = await connect(repo);
    let five = (await itemOf(s, 5))!;
    expect(five).toMatchObject({ path: "work/5-new.md", title: "New", warnings: ["Another file has number 5: done/5-old.md"] });
    repo.commit({ "work/5-a-second.md": item(5, "Second") });
    await s.index.poke(ORG);
    await s.settle();
    five = (await itemOf(s, 5))!;
    expect(five.path).toBe("work/5-a-second.md");
    expect(five.warnings).toHaveLength(2);
    repo.commit({ "work/5-a-second.md": null, "work/5-new.md": null });
    await s.index.poke(ORG);
    await s.settle();
    five = (await itemOf(s, 5))!;
    expect(five).toMatchObject({ path: "done/5-old.md", stage: "closed", title: "Old", warnings: [] });
  });
});

describe("GitHub trouble", () => {
  it("a 429 with retry-after pauses: nothing is asked until it ends, and the read still answers", async () => {
    const repo = new FakeRepo({ "work/1-a.md": item(1, "A") });
    const s = await connect(repo);
    repo.commit({ "work/1-a.md": item(1, "A2") });
    repo.failNext.push({ status: 429, headers: { "retry-after": "120" } });
    s.tick(LOOK_AFTER_MS + 1);
    await open(s);
    await s.settle();
    repo.take();
    s.tick(LOOK_AFTER_MS + 1);
    expect((await open(s)).items[0]!.title).toBe("A");
    await s.settle();
    expect(repo.take()).toEqual([]);
    s.tick(120_000);
    await open(s);
    await s.settle();
    expect((await open(s)).items[0]!.title).toBe("A2");
  });

  it("a 403 rate limit (remaining 0) is a pause, not a problem", async () => {
    const repo = new FakeRepo({ "work/1-a.md": item(1, "A") });
    const s = await connect(repo);
    repo.failNext.push({ status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(s.now() / 1000) + 60) } });
    s.tick(LOOK_AFTER_MS + 1);
    await open(s);
    await s.settle();
    expect((await open(s)).problem).toBeNull();
    expect(Number(s.index["meta"]("pause_until"))).toBeGreaterThan(s.now());
  });

  it("under a fifth of the quota left, the walk stops", async () => {
    const repo = new FakeRepo({ "work/1-a.md": item(1, "A") });
    const s = setup(repo);
    await s.index.setRepository(ORG, { installationId: "inst_1", owner: "acme", name: "knowledge" }, by);
    await s.settle();
    repo.remaining = 900;
    repo.take();
    s.tick(11 * 60_000);
    await s.index.alarm();
    // One call to learn the quota is low, then nothing more.
    expect(repo.take().length).toBeLessThanOrEqual(1);
    expect(s.walkDone()).toBe(false);
  });

  it("a deleted repository sets problem; the alarm retries it slowly and clears it when the repository is back", async () => {
    const repo = new FakeRepo({ "work/1-a.md": item(1, "A") });
    const s = await connect(repo);
    repo.deleted = true;
    s.tick(LOOK_AFTER_MS + 1);
    await open(s);
    await s.settle();
    const r = await open(s);
    expect(r.problem).toBe("repository_not_found");
    expect(r.problemMessage).toMatch(/does not exist/);
    expect(r.repository).toMatchObject({ problem: "repository_not_found", problemMessage: r.problemMessage });
    expect(r.items).toHaveLength(1);
    // Retried after a minute, then two, ...: a read in between asks nothing.
    repo.take();
    s.tick(LOOK_AFTER_MS + 1);
    await open(s);
    await s.settle();
    expect(repo.take()).toEqual([]);
    s.tick(PROBLEM_RETRY_MS);
    expect(await s.index.alarm()).toBe(s.now() + 2 * PROBLEM_RETRY_MS);
    expect(repo.take().length).toBeGreaterThan(0);
    // Back: the next retry heals it, with no reader and no change to the setting.
    repo.deleted = false;
    s.tick(11 * 60_000);
    await s.index.alarm();
    const healed = await open(s);
    expect(healed.problem).toBeNull();
    expect(healed.problemMessage).toBeNull();
  });

  it("a removed installation is installation_removed", async () => {
    const repo = new FakeRepo({ "work/1-a.md": item(1, "A") });
    let connected = true;
    const s = setup(repo, {
      mint: {
        async mintGitHubInstallationToken() {
          return connected ? { outcome: "minted", token: "t", expiresAt: new Date(Date.parse("2026-11-20T00:00:00Z")).toISOString() } : { outcome: "not_connected" };
        },
      },
    });
    await s.index.setRepository(ORG, { installationId: "inst_1", owner: "acme", name: "knowledge" }, by);
    await s.settle();
    connected = false;
    s.index["github"] = null;
    s.tick(LOOK_AFTER_MS + 1);
    await open(s);
    await s.settle();
    expect((await open(s)).problem).toBe("installation_removed");
  });
});

describe("pull requests", () => {
  it("one query at most every 5 minutes; merged is never asked again; unreadable is a plain link", async () => {
    const pr = (n: number) => `https://github.com/acme/app/pull/${n}`;
    const repo = new FakeRepo({ "work/1-a.md": item(1, "A", `PR: ${pr(1)} ${pr(2)} ${pr(3)} https://example.com/x\n`) });
    repo.pulls.set(pr(1), { state: "OPEN", title: "One" });
    repo.pulls.set(pr(2), { state: "MERGED", title: "Two" });
    const s = await connect(repo);
    s.tick(LOOK_AFTER_MS + 1);
    await open(s);
    await s.settle();
    let prs = (await open(s)).items[0]!.pullRequests;
    expect(prs).toEqual([
      { url: pr(1), state: "open", title: "One" },
      { url: pr(2), state: "merged", title: "Two" },
      { url: pr(3), state: null, title: null },
      { url: "https://example.com/x", state: null, title: null },
    ]);
    // Narrowed to the repositories of the links.
    expect(s.mints).toContainEqual({ installationId: "inst_1", permissions: { pull_requests: "read" }, repositories: ["app"] });
    repo.take();
    s.tick(LOOK_AFTER_MS + 1);
    await open(s);
    await s.settle();
    expect(repo.take().filter((l) => l.includes("graphql"))).toEqual([]);
    repo.pulls.set(pr(1), { state: "OPEN", isDraft: true, title: "One" });
    s.tick(PULLS_EVERY_MS);
    await open(s);
    await s.settle();
    const queries = repo.take().filter((l) => l.includes("graphql"));
    expect(queries).toHaveLength(1);
    prs = (await open(s)).items[0]!.pullRequests;
    expect(prs[0]!.state).toBe("draft");
  });
});

describe("history", () => {
  it("merges the work/ and done/ paths, newest first, with session trailers", async () => {
    const repo = new FakeRepo({});
    repo.commit({ "work/1-a.md": item(1, "A") }, "Add 1\n\nbody", { name: "Ana", email: "a@x" });
    repo.commit({ "work/1-a.md": item(1, "A", "x") }, "Edit 1\n\nSession: cs_9", { name: "Bob", email: "b@x" });
    repo.commit({}, "Close 1", { name: "Cy", email: "c@x" }, { "work/1-a.md": "done/1-a.md" });
    const s = await connect(repo);
    const h = await s.index.history(ORG, 1);
    expect(h.ok).toBe(true);
    if (!h.ok) return;
    expect(h.revisions.map((r) => [r.summary, r.authorName, r.sessionId])).toEqual([
      ["Close 1", "Cy", null],
      ["Edit 1", "Bob", "cs_9"],
      ["Add 1", "Ana", null],
    ]);
    expect(h.revisions[0]!.url).toBe(`https://github.com/acme/knowledge/commit/${repo.head}`);
    expect(h.nextCursor).toBeNull();
    expect(await s.index.history(ORG, 99)).toEqual({ ok: false, error: "item_not_found" });
    expect(await s.index.history(ORG, 1, "garbage!")).toEqual({ ok: false, error: "invalid_cursor" });
  });
});

describe("setRepository", () => {
  it("refuses what cannot be read, with the reason", async () => {
    const repo = new FakeRepo({});
    const s = setup(repo);
    expect(await s.index.setRepository(ORG, { installationId: "inst_1", owner: "acme", name: "nope" }, by)).toMatchObject({
      ok: false,
      status: 400,
      code: "invalid_request",
      reason: "repository_not_found",
    });
    expect(await s.index.setRepository(ORG, { installationId: "inst_1", owner: "acme", name: "knowledge", branch: "gone" }, by)).toMatchObject({
      ok: false,
      reason: "branch_not_found",
      field: "branch",
    });
    expect(await s.index.getRepository(ORG)).toBeNull();
  });

  it("wipes the projection when the repository changes, keeps it when it is the same", async () => {
    const repo = new FakeRepo({ "work/1-a.md": item(1, "A") });
    const s = await connect(repo);
    await s.index.setRepository(ORG, { installationId: "inst_1", owner: "acme", name: "knowledge", branch: "main" }, by);
    expect(s.sql.exec("SELECT number FROM items").toArray()).toHaveLength(1);
    repo.defaultBranch = "trunk";
    await s.index.setRepository(ORG, { installationId: "inst_1", owner: "acme", name: "knowledge", branch: "trunk" }, by);
    expect(s.sql.exec("SELECT number FROM items").toArray()).toHaveLength(0);
    await s.settle();
    expect((await open(s)).items.map((i) => i.number)).toEqual([1]);
  });
});

describe("parser version", () => {
  it("re-parses stored bodies in batches behind the reads, never while the object starts, with no GitHub call", async () => {
    const files: Record<string, string> = {};
    for (let n = 1; n <= REPARSE_BATCH + 20; n++) files[`work/${n}-item.md`] = item(n, `Item ${n}`);
    const repo = new FakeRepo(files);
    const s = await connect(repo);
    s.tick(11 * 60_000);
    await s.drain();
    const stale = JSON.stringify({ title: "stale", stateLine: null, tags: [], owner: null, left: null, boxes: 0, pullRequests: [], warnings: [] });
    // Rows of another parser version.
    s.sql.exec("UPDATE items SET parsed = ?, parser = ?", stale, PARSER_VERSION + 1);
    s.sql.exec("UPDATE meta SET v = '0' WHERE k = 'parser_version'");
    repo.take();
    const again = setup(repo, { sql: s.sql });
    // Starting parses nothing: the read answers the stored fields, and the batch runs behind it.
    const first = await again.index.items(ORG, { stage: "open" });
    expect(first.ok && first.items[0]!.title).toBe("stale");
    await again.settle();
    let titles = (await open(again)).items.map((i) => i.title);
    expect(titles.filter((t) => t === "stale")).toHaveLength(20);
    await again.index.alarm();
    titles = (await open(again)).items.map((i) => i.title);
    expect(titles.filter((t) => t === "stale")).toHaveLength(0);
    expect(repo.take().filter((l) => !l.endsWith("/git/ref/heads/main"))).toEqual([]);
  });
});

describe("the alarm", () => {
  it("looks once a minute while there have been reads in the last ten, then stops", async () => {
    const repo = new FakeRepo({ "work/1-a.md": item(1, "A") });
    const s = await connect(repo);
    s.tick(11 * 60_000);
    await s.drain();
    await open(s);
    await s.settle();
    repo.take();
    s.tick(ALARM_EVERY_MS);
    expect(await s.index.alarm()).toBe(s.now() + ALARM_EVERY_MS);
    expect(repo.take()).toEqual(["GET /repos/acme/knowledge/git/ref/heads/main"]);
    s.tick(11 * 60_000);
    expect(await s.index.alarm()).toBeNull();
  });
});

const flush = () => new Promise((resolve) => setImmediate(resolve));
const shape = (lines: string[]) => lines.map((l) => l.split("?")[0]!.replace(/[0-9a-f]{40}/g, "SHA"));
const count = (lines: string[], re: RegExp) => lines.filter((l) => re.test(l)).length;

describe("portability", () => {
  it("index.ts, item.ts, github.ts and platform.ts name no platform; index-do.ts is the adapter", () => {
    const read = (f: string) => readFileSync(decodeURIComponent(new URL(`../src/computer/work/${f}`, import.meta.url).pathname), "utf8");
    for (const f of ["index.ts", "item.ts", "github.ts", "platform.ts"]) {
      const text = read(f);
      expect(text, f).not.toMatch(/cloudflare:/);
      expect(text, f).not.toMatch(/\bSqlStorage\b|\bDurableObject|\bctx\.storage\b|\bDate\.now\(|\bsetTimeout\(|(^|[^.\w])fetch\(/m);
    }
    expect(read("index-do.ts")).toMatch(/from "cloudflare:workers"/);
  });
});

describe("GitHub trouble, 403s and timeouts", () => {
  it("a 403 naming a secondary limit pauses a minute at least; another 403 is temporary; only 'not accessible by integration' is a problem", async () => {
    const repo = new FakeRepo({ "work/1-a.md": item(1, "A") });
    const s = await connect(repo);
    repo.failNext.push({ status: 403, message: "You have exceeded a secondary rate limit. Please wait a few minutes." });
    s.tick(LOOK_AFTER_MS + 1);
    await open(s);
    await s.settle();
    expect((await open(s)).problem).toBeNull();
    expect(Number(s.index["meta"]("pause_until"))).toBeGreaterThanOrEqual(s.now() + DEFAULT_PAUSE_MS);

    s.tick(DEFAULT_PAUSE_MS + 1);
    repo.failNext.push({ status: 403, message: "Forbidden" });
    await open(s);
    await s.settle();
    expect((await open(s)).problem).toBeNull();
    expect(Number(s.index["meta"]("pause_until"))).toBeLessThan(s.now());

    s.tick(LOOK_AFTER_MS + 1);
    repo.failNext.push({ status: 403, message: "Resource not accessible by integration" });
    await open(s);
    await s.settle();
    expect((await open(s)).problem).toBe("access_denied");
  });

  it("a GraphQL rate limit pauses pull request state only; the head still advances", async () => {
    const pr = "https://github.com/acme/app/pull/1";
    const repo = new FakeRepo({ "work/1-a.md": item(1, "A", `PR: ${pr}\n`) });
    repo.pulls.set(pr, { state: "OPEN", title: "One" });
    const s = await connect(repo);
    repo.failNext.push({ status: 403, match: /graphql/, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(s.now() / 1000) + 3600) } });
    s.tick(LOOK_AFTER_MS + 1);
    await open(s);
    await s.settle();
    expect(Number(s.index["meta"]("pulls_pause_until"))).toBeGreaterThan(s.now() + 30 * 60_000);
    expect(s.index["meta"]("pause_until")).toBeNull();
    repo.commit({ "work/1-a.md": item(1, "A2", `PR: ${pr}\n`) });
    s.tick(PULLS_EVERY_MS);
    repo.take();
    await open(s);
    await s.settle();
    expect((await open(s)).items[0]!.title).toBe("A2");
    expect(count(repo.take(), /graphql/)).toBe(0);
  });

  it("a request GitHub never answers is aborted after 10 s; reads answer meanwhile and the chain is free after", async () => {
    const repo = new FakeRepo({ "work/1-a.md": item(1, "A") });
    const s = await connect(repo);
    repo.commit({ "work/1-a.md": item(1, "A2") });
    repo.hangNext = 1;
    s.tick(LOOK_AFTER_MS + 1);
    await open(s);
    await flush();
    // The look hangs on the head; reads do not wait for it.
    expect((await open(s)).items[0]!.title).toBe("A");
    expect((await s.index.item(ORG, 1)).ok).toBe(true);
    s.tick(REQUEST_TIMEOUT_MS);
    await s.settle();
    s.tick(LOOK_AFTER_MS + 1);
    await open(s);
    await s.settle();
    expect((await open(s)).items[0]!.title).toBe("A2");
  });

  it("a closed item not read yet answers unavailable within 5 s when GitHub hangs, and reads on the next try", async () => {
    const repo = new FakeRepo({ "work/1-a.md": item(1, "A"), "done/3-old.md": item(3, "Old") });
    const s = await connect(repo);
    repo.hangNext = 1;
    const answer = s.index.item(ORG, 3);
    await flush();
    s.tick(READ_WAIT_MS);
    expect(await answer).toMatchObject({ ok: false, error: "unavailable" });
    s.tick(REQUEST_TIMEOUT_MS);
    await s.settle();
    expect(await s.index.item(ORG, 3)).toMatchObject({ ok: true, item: { parsed: true, title: "Old" } });
  });

  it("history while the walk is not done answers unavailable within 5 s when GitHub hangs", async () => {
    const repo = new FakeRepo({ "work/1-a.md": item(1, "A") });
    const s = setup(repo);
    await s.index.setRepository(ORG, { installationId: "inst_1", owner: "acme", name: "knowledge" }, by);
    await s.settle();
    expect(s.walkDone()).toBe(false);
    repo.hangNext = 5;
    const answer = s.index.history(ORG, 1);
    await flush();
    s.tick(READ_WAIT_MS);
    expect(await answer).toMatchObject({ ok: false, error: "unavailable", retryAfterMs: expect.any(Number) });
    s.tick(REQUEST_TIMEOUT_MS);
    await s.settle();
  });
});

describe("the setting", () => {
  it("a stale problem never refuses setRepository; the setting clears it", async () => {
    const repo = new FakeRepo({ "work/1-a.md": item(1, "A") });
    const s = await connect(repo);
    repo.deleted = true;
    s.tick(LOOK_AFTER_MS + 1);
    await open(s);
    await s.settle();
    expect((await open(s)).problem).toBe("repository_not_found");
    repo.deleted = false;
    const r = await s.index.setRepository(ORG, { installationId: "inst_1", owner: "acme", name: "knowledge" }, by);
    expect(r).toMatchObject({ ok: true, value: { problem: null, problemMessage: null } });
    // The same repository: the projection stays.
    expect(s.sql.exec("SELECT number FROM items").toArray()).toHaveLength(1);
  });

  it("the owner must be the installation's account", async () => {
    const repo = new FakeRepo({ "work/1-a.md": item(1, "A") });
    const s = setup(repo);
    expect(await s.index.setRepository(ORG, { installationId: "inst_1", owner: "someone-else", name: "knowledge" }, by)).toMatchObject({
      ok: false,
      status: 400,
      field: "owner",
      reason: "owner_mismatch",
    });
    expect(repo.take()).toEqual([]);
  });

  it("follows a renamed repository: through GitHub's redirect, or by its id when the old name is gone", async () => {
    for (const redirects of [true, false]) {
      const repo = new FakeRepo({ "work/1-a.md": item(1, "A") });
      const s = await connect(repo);
      repo.redirects = redirects;
      repo.rename("kb");
      repo.commit({ "work/1-a.md": item(1, "A2") });
      s.tick(LOOK_AFTER_MS + 1);
      await open(s);
      await s.settle();
      s.tick(LOOK_AFTER_MS + 1);
      await open(s);
      await s.settle();
      const r = await open(s);
      expect(r.repository, `redirects ${redirects}`).toMatchObject({ owner: "acme", name: "kb", problem: null });
      expect(r.items[0]).toMatchObject({ title: "A2", url: "https://github.com/acme/kb/blob/main/work/1-a.md" });
    }
  });
});

describe("dates and closers", () => {
  it("a close the advance did not detail has no closedAt or closedBy until the walk reaches it (never the newest commit, never 1970)", async () => {
    const repo = new FakeRepo({ "work/1-a.md": item(1, "A"), "work/2-b.md": item(2, "B") });
    const s = await connect(repo);
    s.tick(11 * 60_000);
    await s.drain();
    const close = repo.commit({}, "Close 1", { name: "Bob", email: "bob@acme.test" }, { "work/1-a.md": "done/1-a.md" });
    for (let i = 0; i < ADVANCE_DETAILS + 2; i++) repo.commit({ "work/2-b.md": item(2, "B", `v${i}`) }, `Edit ${i}`, { name: "Cy", email: "cy@acme.test" });
    await s.index.poke(ORG);
    await s.settle();
    expect(await itemOf(s, 1)).toMatchObject({ stage: "closed", closedAt: null, closedBy: null, updatedAt: null });
    expect((await itemOf(s, 2))!.updatedAt).toBe(repo.commits.get(repo.head!)!.at);
    s.tick(11 * 60_000);
    await s.drain();
    expect(await itemOf(s, 1)).toMatchObject({ closedAt: repo.commits.get(close)!.at, closedBy: "Bob", updatedAt: repo.commits.get(close)!.at });
  });
});

describe("history from the walk", () => {
  it("is served from stored revisions across renames and the move to done/, paged by a keyset cursor, with no GitHub call", async () => {
    const repo = new FakeRepo({});
    repo.commit({ "work/1-a.md": item(1, "A") }, "Add 1");
    for (let i = 0; i < 35; i++) repo.commit({ "work/1-a.md": item(1, "A", `v${i}`) }, `Edit ${i}${i === 3 ? "\n\nSession: cs_3" : ""}`);
    repo.commit({}, "Rename 1", { name: "Ana", email: "ana@acme.test" }, { "work/1-a.md": "work/1-better.md" });
    repo.commit({}, "Close 1", { name: "Ana", email: "ana@acme.test" }, { "work/1-better.md": "done/1-better.md" });
    repo.commit({ "work/2-x.md": item(2, "X") }, "Add 2");
    const s = await connect(repo);
    s.tick(11 * 60_000);
    await s.drain();
    expect(s.walkDone()).toBe(true);
    repo.take();
    const first = await s.index.history(ORG, 1);
    if (!first.ok) throw new Error("not ok");
    expect(first.revisions).toHaveLength(30);
    expect(first.revisions.slice(0, 3).map((r) => r.summary)).toEqual(["Close 1", "Rename 1", "Edit 34"]);
    const second = await s.index.history(ORG, 1, first.nextCursor!);
    if (!second.ok) throw new Error("not ok");
    expect(second.revisions.map((r) => r.summary).slice(-2)).toEqual(["Edit 0", "Add 1"]);
    expect(second.revisions).toHaveLength(38 - 30);
    expect(second.nextCursor).toBeNull();
    expect(second.revisions.find((r) => r.summary === "Edit 3")!.sessionId).toBe("cs_3");
    await s.settle();
    // A read may look at the head (once a 10 s window); history itself asks GitHub nothing.
    expect(repo.take().filter((l) => !l.includes("/git/ref/"))).toEqual([]);
  });
});
describe("call budgets", () => {
  it("the first build of 150 open and 500 closed items: a ref, three trees and the 150 open blobs; then the walk", async () => {
    const files: Record<string, string> = {};
    for (let n = 1; n <= 150; n++) files[`work/${n}-open.md`] = item(n, `Open ${n}`);
    for (let n = 151; n <= 650; n++) files[`done/${n}-closed.md`] = item(n, `Closed ${n}`);
    const repo = new FakeRepo(files);
    const s = setup(repo);
    await s.index.setRepository(ORG, { installationId: "inst_1", owner: "acme", name: "knowledge" }, by);
    // The setting's check: the repository and the branch.
    expect(shape(repo.take())).toEqual(["GET /repos/acme/knowledge", "GET /repos/acme/knowledge/git/ref/heads/main"]);
    await s.settle();
    for (let i = 0; i < 10 && s.index["meta"]("build") !== null; i++) {
      s.tick(1000);
      await s.index.alarm();
    }
    expect(s.index["meta"]("build")).toBeNull();
    const build = repo.take();
    expect(count(build, /\/git\/ref\//)).toBe(1);
    expect(count(build, /\/git\/trees\//)).toBe(3);
    expect(count(build, /\/git\/blobs\//)).toBe(150);
    expect(build).toHaveLength(154);
    expect((await open(s)).items).toHaveLength(150);
    // The walk: a page of each folder's commits, and the import commit's 650 files in 3 pages.
    s.tick(11 * 60_000);
    await s.drain();
    const walk = repo.take();
    expect(count(walk, /\/commits\?/)).toBe(2);
    expect(count(walk, /\/commits\/[0-9a-f]{40}/)).toBe(3);
    const rows = s.sql.exec("SELECT COUNT(*) AS n FROM items WHERE created_at IS NULL").toArray()[0] as { n: number };
    expect(rows.n).toBe(0);
  });

  it("an advance over 500 commits touching 400 other files stays an advance, within its budget; the walk finishes the dates", async () => {
    const files: Record<string, string> = {};
    for (let n = 1; n <= 150; n++) files[`work/${n}-item.md`] = item(n, `Item ${n}`);
    const repo = new FakeRepo(files);
    const s = await connect(repo);
    s.tick(11 * 60_000);
    await s.drain();
    expect(s.walkDone()).toBe(true);
    for (let k = 0; k < 400; k++) repo.commit({ [`notes/${k}.md`]: `note ${k}` }, `Note ${k}`);
    for (let n = 1; n <= 100; n++) repo.commit({ [`work/${n}-item.md`]: item(n, `Item ${n}`, "edited") }, `Edit ${n}\n\nSession: cs_${n}`);
    repo.take();
    await s.index.poke(ORG);
    await s.settle();
    const calls = repo.take();
    // ref + compare + root and work/ trees + 100 changed blobs + the range's second page of commits + 10 details.
    const budget = 1 + 1 + 2 + 100 + 1 + ADVANCE_DETAILS;
    expect(calls.length).toBeLessThanOrEqual(budget);
    expect(count(calls, /\/compare\//)).toBe(2);
    expect(count(calls, /\/git\/trees\//)).toBe(2);
    expect(count(calls, /\/git\/blobs\//)).toBe(100);
    expect(count(calls, /\/commits\/[0-9a-f]{40}/)).toBeLessThanOrEqual(ADVANCE_DETAILS);
    expect(count(calls, /per_page=1(&|$)/)).toBe(0);
    const r = await open(s);
    expect(r.head).toBe(repo.head);
    expect(r.building).toBe(false);
    expect(byNumber(r).get(100)!.stateLine).toContain("edited");
    s.tick(11 * 60_000);
    await s.drain();
    const after = byNumber(await open(s));
    expect(after.get(1)!.sessionIds).toEqual(["cs_1"]);
    expect(after.get(1)!.updatedAt).not.toBeNull();
    expect(after.get(150)!.sessionIds).toEqual([]);
    expect(s.walkDone()).toBe(true);
  });

  it("150 items and 300 commits: the build as before, then a walk of a commit listing page per 100 and a detail per commit; activity and owners cost no more", async () => {
    const files: Record<string, string> = {};
    for (let n = 1; n <= 150; n++) files[`work/${n}-item.md`] = item(n, `Item ${n}`);
    const repo = new FakeRepo(files);
    for (let k = 0; k < 300; k++) {
      const n = (k % 150) + 1;
      repo.commit({ [`work/${n}-item.md`]: item(n, `Item ${n}`, `edit ${k}`) }, `Edit ${n}`, { name: `P${k % 7} via Computer`, email: `p${k % 7}@acme.test` });
    }
    const s = setup(repo, { clock: new FakeClock(Date.parse("2026-11-02T00:00:00Z")) });
    await s.index.setRepository(ORG, { installationId: "inst_1", owner: "acme", name: "knowledge" }, by);
    repo.take();
    await s.settle();
    for (let i = 0; i < 10 && s.index["meta"]("build") !== null; i++) {
      s.tick(1000);
      await s.index.alarm();
    }
    expect(repo.take()).toHaveLength(1 + 2 + 150);
    s.tick(11 * 60_000);
    await s.drain();
    expect(s.walkDone()).toBe(true);
    const walk = repo.take();
    // 301 commits touch work/ (the import and 300 edits): 4 pages of 100, and done/'s one page.
    expect(count(walk, /\/commits\?/)).toBe(5);
    expect(count(walk, /\/commits\/[0-9a-f]{40}/)).toBe(301);
    expect(walk).toHaveLength(5 + 301);
    const r = byNumber(await open(s));
    // Item 1 was last edited by the 151st edit, k = 150.
    expect(r.get(1)!.owner).toMatchObject({ source: "derived", name: "P3", email: "p3@acme.test" });
    expect(r.get(1)!.lastActivityAt).not.toBeNull();
  });

  it("a board poll on an unchanged head is one ref request a 10 s window, a 304; an item page is no call", async () => {
    const repo = new FakeRepo({ "work/1-a.md": item(1, "A") });
    const s = await connect(repo);
    s.tick(11 * 60_000);
    await s.drain();
    repo.take();
    for (let i = 0; i < 5; i++) {
      s.tick(2_000);
      await open(s);
      await s.settle();
    }
    expect(shape(repo.take())).toEqual(["GET /repos/acme/knowledge/git/ref/heads/main"]);
    await s.index.item(ORG, 1);
    await s.index.history(ORG, 1);
    await s.settle();
    expect(repo.take()).toEqual([]);
  });
});

describe("pull request polling", () => {
  it("asks the never-asked first then the longest ago, never a merged or closed one again, unreadable after a day, narrowed to the account's repositories", async () => {
    const urls: string[] = [];
    for (let n = 1; n <= 55; n++) urls.push(`https://github.com/acme/app/pull/${n}`);
    urls.push("https://github.com/acme/Site/pull/1", "https://github.com/other/x/pull/1");
    const repo = new FakeRepo({ "work/1-a.md": item(1, "A", `PR: ${urls.join(" ")}\n`) });
    for (const url of urls.slice(0, 56)) repo.pulls.set(url, { state: "OPEN", title: url });
    repo.pulls.set(urls[0]!, { state: "MERGED", title: "merged" });
    const s = await connect(repo);
    const asked = () => repo.queries.splice(0).flatMap((q) => [...q.matchAll(/owner: "([^"]+)", name: "([^"]+)"\) \{ pullRequest\(number: (\d+)\)/g)].map((m) => `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`));
    s.tick(LOOK_AFTER_MS + 1);
    await open(s);
    await s.settle();
    const first = asked();
    expect(first).toHaveLength(PULLS_PER_QUERY);
    // The other account's link is never asked, and is unreadable.
    expect(first).not.toContain("https://github.com/other/x/pull/1");
    const pullMints = s.mints.filter((m) => (m as { permissions: object }).permissions.hasOwnProperty("pull_requests")) as { repositories: string[] }[];
    for (const m of pullMints) for (const name of m.repositories) expect(["app", "site"]).toContain(name);

    s.tick(PULLS_EVERY_MS);
    await open(s);
    await s.settle();
    const second = asked();
    // Every link never asked comes first; the merged one is not asked again.
    const never = urls.slice(0, 56).filter((u) => !first.includes(u));
    for (const u of never) expect(second).toContain(u);
    expect(second).not.toContain(urls[0]);
    expect(second).not.toContain("https://github.com/other/x/pull/1");
    const prs = (await open(s)).items[0]!.pullRequests;
    expect(prs.find((p) => p.url === urls[0])!.state).toBe("merged");
    expect(prs.find((p) => p.url.includes("other/x"))!.state).toBeNull();
    const unreadable = s.sql.exec("SELECT state FROM pulls WHERE url = ?", "https://github.com/other/x/pull/1").toArray()[0] as { state: string };
    expect(unreadable.state).toBe("unreadable");
  });

  it("asks an unreadable link again only after a day", async () => {
    const gone = "https://github.com/acme/app/pull/9";
    const repo = new FakeRepo({ "work/1-a.md": item(1, "A", `PR: ${gone}\n`) });
    const s = await connect(repo);
    const asks = () => repo.take().filter((l) => l.includes("graphql")).length;
    s.tick(LOOK_AFTER_MS + 1);
    await open(s);
    await s.settle();
    expect(asks()).toBe(1);
    expect(s.sql.exec("SELECT state FROM pulls").toArray()).toEqual([{ state: "unreadable" }]);
    s.tick(PULLS_EVERY_MS + 1);
    await open(s);
    await s.settle();
    expect(asks()).toBe(0);
    repo.pulls.set(gone, { state: "OPEN", title: "Back" });
    s.tick(UNREADABLE_RECHECK_MS);
    await open(s);
    await s.settle();
    expect(asks()).toBe(1);
    expect((await open(s)).items[0]!.pullRequests).toEqual([{ url: gone, state: "open", title: "Back" }]);
  });
});

describe("large and unstorable files", () => {
  it("keeps a file over the store's limit cut by bytes, with a warning, and the build finishes", async () => {
    // Three-byte characters: 3 MB of UTF-8, over Durable Object SQLite's 2 MB string limit.
    const huge = `# 2. Huge\n\nState of Huge.\n${"€".repeat(1_000_000)}\n`;
    const repo = new FakeRepo({ "work/1-board.md": item(1, "Board"), "work/2-huge.md": huge });
    const s = await connect(repo);
    const r = await open(s);
    expect(r.building).toBe(false);
    expect(r.head).toBe(repo.head);
    const two = byNumber(r).get(2)!;
    expect(two.title).toBe("Huge");
    expect(two.warnings).toContain("The file is larger than 1 MB; only the start is read.");
    const got = await s.index.item(ORG, 2);
    expect(got.ok && Buffer.byteLength(got.body!)).toBeLessThanOrEqual(BODY_STORE_BYTES);
    // Cut at a character boundary: no replacement character at the end.
    expect(got.ok && got.body!.endsWith("€")).toBe(true);

    // An advance to a still larger file is cut the same way.
    repo.commit({ "work/2-huge.md": `${huge}${"€".repeat(10)}` });
    s.tick(LOOK_AFTER_MS + 1);
    await open(s);
    await s.settle();
    const after = await open(s);
    expect(after.head).toBe(repo.head);
    expect(byNumber(after).get(2)!.warnings).toContain("The file is larger than 1 MB; only the start is read.");
  });

  it("makes a row that cannot be written that row's problem, in a build and in an advance", async () => {
    const repo = new FakeRepo({ "work/1-board.md": item(1, "Board"), "work/2-bad.md": item(2, "Bad") });
    const refuse = (store: IndexStore): IndexStore => ({
      ...store,
      exec(query, ...params) {
        if (params.some((p) => typeof p === "string" && p.includes("State of Bad"))) throw new Error("SQLITE_TOOBIG");
        return store.exec(query, ...params);
      },
    });
    const s = setup(repo, { store: refuse });
    await s.index.setRepository(ORG, { installationId: "inst_1", owner: "acme", name: "knowledge" }, by);
    await s.settle();
    await s.drain();
    const r = await open(s);
    expect(r.building).toBe(false);
    expect(r.items.map((i) => [i.number, i.title])).toEqual([
      [1, "Board"],
      [2, "bad"],
    ]);
    expect(byNumber(r).get(2)!.warnings).toEqual(["The file could not be stored; only its name is shown."]);
    expect(byNumber(r).get(2)!.parsed).toBe(true);

    repo.commit({ "work/1-board.md": item(1, "Board 2"), "work/2-bad.md": item(2, "Bad", "more") });
    s.tick(LOOK_AFTER_MS + 1);
    await open(s);
    await s.settle();
    const after = await open(s);
    expect(after.head).toBe(repo.head);
    expect(after.problem).toBeNull();
    expect(byNumber(after).get(1)!.title).toBe("Board 2");
    expect(byNumber(after).get(2)!.warnings).toEqual(["The file could not be stored; only its name is shown."]);
  });
});

describe("merge commits", () => {
  it("details a pull request branch's commits dated before the cursor but merged after it", async () => {
    const repo = new FakeRepo({ "work/1-a.md": item(1, "A") });
    const s = await connect(repo);
    s.tick(11 * 60_000);
    await s.drain();
    // A branch commit, then main moves on (the cursor passes it by date), then the merge.
    const fork = repo.head!;
    const onBranch = repo.branchCommit(fork, { "work/2-b.md": item(2, "B") }, "Add 2\n\nSession: cs_branch", { name: "Bob", email: "bob@acme.test" });
    repo.commit({ "work/1-a.md": item(1, "A", "edited") }, "Edit 1");
    await s.index.poke(ORG);
    await s.settle();
    s.tick(11 * 60_000);
    await s.drain();
    repo.merge(onBranch);
    await s.index.poke(ORG);
    await s.settle();
    s.tick(11 * 60_000);
    await s.drain();
    expect(s.walkDone()).toBe(true);
    const two = byNumber(await open(s)).get(2)!;
    expect(two.sessionIds).toEqual(["cs_branch"]);
    expect(two.createdAt).toBe(repo.commits.get(onBranch)!.at);
    expect(two.author).toEqual({ name: "Bob", email: "bob@acme.test" });
    expect(two.updatedAt).toBe(repo.commits.get(onBranch)!.at);
    const history = await s.index.history(ORG, 2);
    expect(history.ok && history.revisions.map((r) => r.summary)).toEqual(["Add 2"]);
  });
});
