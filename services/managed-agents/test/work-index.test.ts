import { describe, expect, it } from "vitest";

import type { TokenMinter } from "../src/computer/work/github.js";
import { ALARM_EVERY_MS, FILL_BATCH, LOOK_AFTER_MS, PULLS_EVERY_MS, REPARSE_BATCH, WorkIndex } from "../src/computer/work/index.js";
import type { IndexedItem, ItemsResult } from "../src/computer/work/index-contract.js";
import { PARSER_VERSION } from "../src/computer/work/item.js";
import { sqlStorage } from "./fixtures/computer-sql.js";
import { FakeRepo } from "./fixtures/fake-github-repo.js";

/** Work tracking 3.6: the Work index against a fake GitHub. */

const ORG = "acct_1";
const by = { member: "m_1", name: "Ana", email: "ana@acme.test" };

function setup(repo: FakeRepo, options: { sql?: SqlStorage; mint?: TokenMinter } = {}) {
  let t = Date.parse("2026-11-19T10:00:00Z");
  const pending: Promise<unknown>[] = [];
  const mints: unknown[] = [];
  let alarmAt: number | null = null;
  const sql = options.sql ?? sqlStorage();
  const account: TokenMinter = options.mint ?? {
    async mintGitHubInstallationToken(input) {
      mints.push(input);
      return { outcome: "minted", token: "ghs_test", expiresAt: new Date(t + 3_600_000).toISOString() };
    },
  };
  const index = new WorkIndex({
    sql,
    transaction: (fn) => fn(),
    account: () => account,
    arm: async (at) => {
      if (alarmAt === null || at < alarmAt) alarmAt = at;
    },
    waitUntil: (p) => void pending.push(p),
    fetch: repo.fetch,
    now: () => t,
  });
  const settle = async () => {
    while (pending.length) await Promise.allSettled(pending.splice(0));
  };
  return {
    index,
    sql,
    mints,
    settle,
    tick: (ms: number) => (t += ms),
    now: () => t,
    alarmAt: () => alarmAt,
    /** Runs alarms until there is nothing more to do (or `max` runs). */
    async drain(max = 50) {
      for (let i = 0; i < max; i++) {
        const next = await index.alarm();
        await settle();
        if (next === null) return;
        t = Math.max(t, next);
        if (index["meta"]("build") === null && index["meta"]("walk") === null && t - Number(index["meta"]("read_at")) > 10 * 60_000) return;
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
    expect(r.items[0]!.updatedAt).toBe(repo.commits.get(repo.head!)!.at);
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
    const one = (await s.index.item(ORG, 1)).item!;
    expect(one.author).toEqual({ name: "Bob", email: "bob@acme.test" });
    expect(one.createdAt).toBe([...repo.commits.values()][1]!.at);
    expect(one.sessionIds).toEqual(["cs_one"]);
    const two = (await s.index.item(ORG, 2)).item!;
    expect(two.stage).toBe("closed");
    expect(two.closedBy).toBe("Cy");
    expect(two.closedAt).toBe(repo.commits.get(repo.head!)!.at);
    expect(s.index["meta"]("walk")).toBeNull();
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
    let one = (await s.index.item(ORG, 1)).item!;
    expect(one).toMatchObject({ stage: "closed", path: "done/1-a.md", closedBy: "Bob", closedAt: repo.commits.get(repo.head!)!.at, readyToClose: false });
    expect((await open(s)).items.map((i) => i.number)).toEqual([2]);
    // Two commits: a session closes 2 (no closer name), then 1 is reopened.
    repo.commit({}, "Close 2\n\nSession: cs_x", { name: "Cy", email: "cy@acme.test" }, { "work/2-b.md": "done/2-b.md" });
    repo.commit({}, "Reopen 1", { name: "Ana", email: "ana@acme.test" }, { "done/1-a.md": "work/1-a.md" });
    await s.index.poke(ORG);
    await s.settle();
    one = (await s.index.item(ORG, 1)).item!;
    expect(one).toMatchObject({ stage: "open", closedAt: null, closedBy: null });
    const two = (await s.index.item(ORG, 2)).item!;
    expect(two).toMatchObject({ stage: "closed", closedBy: null, sessionIds: ["cs_x"] });
    expect(two.closedAt).toBe([...repo.commits.values()].at(-2)!.at);
  });

  it("Session: trailers link: one commit uses the range's files, more ask only the trailer commits", async () => {
    const repo = new FakeRepo({ "work/1-a.md": item(1, "A"), "work/2-b.md": item(2, "B") });
    const s = await connect(repo);
    repo.take();
    repo.commit({ "work/1-a.md": item(1, "A", "more") }, "Edit\n\nSession: cs_1");
    await s.index.poke(ORG);
    await s.settle();
    expect(repo.take().some((l) => /\/commits\/[0-9a-f]{40}$/.test(l))).toBe(false);
    expect((await s.index.item(ORG, 1)).item!.sessionIds).toEqual(["cs_1"]);

    repo.commit({ "work/2-b.md": item(2, "B", "x") }, "Edit 2\n\nSession: cs_2");
    repo.commit({ "work/1-a.md": item(1, "A", "y") }, "Edit 1 by hand");
    repo.take();
    await s.index.poke(ORG);
    await s.settle();
    expect(repo.take().filter((l) => /\/commits\/[0-9a-f]{40}$/.test(l))).toHaveLength(1);
    expect((await s.index.item(ORG, 2)).item!.sessionIds).toEqual(["cs_2"]);
    expect((await s.index.item(ORG, 1)).item!.sessionIds).toEqual(["cs_1"]);
  });

  it("an added item takes its author from the commit; a removed one loses its row and links", async () => {
    const repo = new FakeRepo({ "work/1-a.md": item(1, "A") });
    const s = await connect(repo);
    repo.commit({ "work/2-b.md": item(2, "B") }, "Add 2\n\nSession: cs_2", { name: "Bob", email: "bob@acme.test" });
    await s.index.poke(ORG);
    await s.settle();
    expect((await s.index.item(ORG, 2)).item).toMatchObject({ author: { name: "Bob", email: "bob@acme.test" }, sessionIds: ["cs_2"] });
    repo.commit({ "work/2-b.md": null }, "Remove 2");
    await s.index.poke(ORG);
    await s.settle();
    expect((await s.index.item(ORG, 2)).item).toBeNull();
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
    let five = (await s.index.item(ORG, 5)).item!;
    expect(five).toMatchObject({ path: "work/5-new.md", title: "New", warnings: ["Another file has number 5: done/5-old.md"] });
    repo.commit({ "work/5-a-second.md": item(5, "Second") });
    await s.index.poke(ORG);
    await s.settle();
    five = (await s.index.item(ORG, 5)).item!;
    expect(five.path).toBe("work/5-a-second.md");
    expect(five.warnings).toHaveLength(2);
    repo.commit({ "work/5-a-second.md": null, "work/5-new.md": null });
    await s.index.poke(ORG);
    await s.settle();
    five = (await s.index.item(ORG, 5)).item!;
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
    expect(s.index["meta"]("walk")).not.toBeNull();
  });

  it("a deleted repository sets problem; it clears when the repository is back", async () => {
    const repo = new FakeRepo({ "work/1-a.md": item(1, "A") });
    const s = await connect(repo);
    repo.deleted = true;
    s.tick(LOOK_AFTER_MS + 1);
    await open(s);
    await s.settle();
    const r = await open(s);
    expect(r.problem).toBe("repository_not_found");
    expect(r.repository!.problem).toBe("repository_not_found");
    expect(r.items).toHaveLength(1);
    repo.deleted = false;
    s.tick(LOOK_AFTER_MS + 1);
    await open(s);
    await s.settle();
    expect((await open(s)).problem).toBeNull();
  });

  it("a removed installation is installation_removed", async () => {
    const repo = new FakeRepo({ "work/1-a.md": item(1, "A") });
    let connected = true;
    const s = setup(repo, {
      mint: {
        async mintGitHubInstallationToken() {
          return connected ? { outcome: "minted", token: "t", expiresAt: new Date(Date.now() + 3_600_000).toISOString() } : { outcome: "not_connected" };
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
    expect(s.mints).toContainEqual({ installationId: "inst_1", permissions: { pull_requests: "read" } });
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
