// Org's attachment rows (work 126, sections 3, 5, 6, 8): the state machine of one row, who may,
// the quotas, the attachments a turn names, the sweep on the alarm, and a session's removal.

import { describe, expect, it, vi } from "vitest";
import type { Principal } from "../src/auth/principal.js";
import type { Attachments } from "../src/attachments/store.js";
import type { OrgDurableObject } from "../src/actors/org/durable-object.js";
import { ATTACHMENT_DELETED_KEEP_MS, ATTACHMENT_ORG_BYTES_MAX, ATTACHMENT_ORPHAN_TTL_MS, ATTACHMENT_SESSION_BYTES_MAX, ATTACHMENT_UPLOADING_TTL_MS } from "../src/actors/org/limits.js";
import { bytesOf } from "../src/actors/org/attachments.js";
import { member, seedThread, withActor, type Fakes } from "./org.test.js";

const SID = "cs_0000000000000101";
const DRAFT = "cs_0000000000000102";
const AT1 = "at_0000000000000001";
const AT2 = "at_0000000000000002";
const AT3 = "at_0000000000000003";
const TURN = "tn_000000000001";
const spec = (over: Partial<{ name: string; mimetype: string; bytes: number }> = {}) => ({ name: "notes.txt", mimetype: "text/plain", bytes: 12, ...over });

const agentOf = (session: string, org: string): Principal => ({ ...member(session, org), subject: session, session, kind: "agent", via: "agent", audiences: [] });
const platform = (org: string): Principal => ({ ...member("platform", org), kind: "platform", audiences: ["org"] });

/** A store that records what Org asks of it. */
function store(): Attachments & { deleted: string[]; removed: string[] } {
  const s = {
    deleted: [] as string[],
    removed: [] as string[],
    uploadUrl: vi.fn(async () => ({ url: "https://store.test/put", headers: {} })),
    downloadUrl: vi.fn(async () => "https://store.test/get"),
    head: vi.fn(async () => null),
    delete: async (key: string) => void s.deleted.push(key),
    removeAll: async (prefix: string) => void s.removed.push(prefix),
  };
  return s;
}

/** A session a owns, under the organization's default access (`owner`): nobody else sees it. */
async function owned(org: OrgDurableObject, a: Principal, id = SID): Promise<void> {
  const made = await org.createSession(a, { id });
  if (!made.ok) throw new Error(made.code);
}

/** The session open to the organization to read, its owner its one writer. */
async function readersOnly(org: OrgDurableObject, a: Principal, id = SID): Promise<void> {
  const opened = await org.patchSession(a, id, { access: { mode: "org" } });
  if (!opened.ok) throw new Error(opened.code);
  await org.mutate(a, { name: "thread.writers", args: { sid: id, writers: [`user:${a.subject}`] } });
}

const fakes = (): Fakes & { attachments: ReturnType<typeof store> } => ({ calls: [], attachments: store() });
const owedCalls = (sql: { exec: <T>(q: string, ...a: unknown[]) => T[] }) => sql.exec<{ call: string; key: string }>("SELECT call, key FROM _owed WHERE call LIKE 'Attachments.%' ORDER BY key");
const alarmAt = (sql: { exec: <T>(q: string, ...a: unknown[]) => T[] }) => sql.exec<{ at: number }>("SELECT at FROM _alarm WHERE purpose = 'attachments'")[0]?.at ?? null;

describe("Org's attachment rows: one upload's states (work 126, section 3)", () => {
  it("creates the row uploading, marks it ready with the etag, and answers the same row to a retry", async () => {
    await withActor("at-states", async (org, _f, sql) => {
      const a = member("usr_a", "at-states");
      await org.feed(a, {}); // the actor migrates on its first use
      seedThread(sql, SID, "usr_a");
      const made = await org.attachmentCreate(a, SID, AT1, spec());
      expect(made).toMatchObject({ ok: true, created: true, attachment: { id: AT1, sessionId: SID, by: "user:usr_a", name: "notes.txt", mimetype: "text/plain", bytes: 12, state: "uploading", etag: null, attachedTo: null } });
      // The sweep is armed for the uploading row's TTL.
      expect(alarmAt(sql)).toBeGreaterThan(Date.now() + ATTACHMENT_UPLOADING_TTL_MS - 60_000);
      // Still uploading: the same row, for a new upload URL.
      expect(await org.attachmentCreate(a, SID, AT1, spec())).toMatchObject({ ok: true, created: false, attachment: { state: "uploading" } });
      expect(await org.attachmentReady(AT1, '"abc"')).toMatchObject({ ok: true, attachment: { state: "ready", etag: '"abc"' } });
      // Ready: the same row again, and a second `ready` keeps the first etag; another size or session, another uploader or a bad id are refused.
      expect(await org.attachmentReady(AT1, '"other"')).toMatchObject({ ok: true, attachment: { state: "ready", etag: '"abc"' } });
      expect(await org.attachmentCreate(a, SID, AT1, spec())).toMatchObject({ ok: true, created: false, attachment: { state: "ready" } });
      expect(await org.attachmentCreate(a, SID, AT1, spec({ bytes: 13 }))).toMatchObject({ ok: false, code: "content_mismatch", status: 400 });
      expect(await org.attachmentCreate(a, DRAFT, AT1, spec())).toMatchObject({ ok: false, code: "content_mismatch" });
      expect(await org.attachmentCreate(member("usr_b", "at-states"), DRAFT, AT1, spec())).toMatchObject({ ok: false, code: "forbidden", status: 403 });
      expect(await org.attachmentCreate(a, SID, "at_nope", spec())).toMatchObject({ ok: false, code: "invalid_request", status: 400 });
      expect(await org.attachmentReady("at_0000000000000009", '"x"')).toMatchObject({ ok: false, code: "attachment_not_found", status: 404 });
      // Nothing is armed once every row is ready in a session Org holds.
      expect(alarmAt(sql)).toBeNull();
    });
  });

  it("deletes: the row deleted, the object's delete owed and sent, then 410 to every later reference", async () => {
    const f = fakes();
    await withActor("at-delete", async (org, _f, sql) => {
      const a = member("usr_a", "at-delete");
      await org.feed(a, {}); // the actor migrates on its first use
      seedThread(sql, SID, "usr_a");
      await org.attachmentCreate(a, SID, AT1, spec());
      await org.attachmentReady(AT1, '"e"');
      expect(await org.attachmentDelete(a, SID, AT1)).toEqual({ ok: true });
      expect(owedCalls(sql)).toEqual([{ call: "Attachments.delete", key: `attachment:${AT1}` }]);
      await org.drain();
      expect(f.attachments.deleted).toEqual([`at-delete/${SID}/${AT1}`]);
      expect(await org.attachmentRead(a, SID, AT1)).toMatchObject({ ok: false, code: "attachment_deleted", status: 410 });
      expect(await org.attachmentDelete(a, SID, AT1)).toMatchObject({ ok: false, code: "attachment_deleted" });
      expect(await org.attachmentCreate(a, SID, AT1, spec())).toMatchObject({ ok: false, code: "attachment_deleted" });
      expect(await org.attachmentReserve(a, SID, TURN, null, [AT1])).toMatchObject({ ok: false, code: "attachment_deleted", attachmentId: AT1 });
      expect(await org.attachmentList(a, SID)).toEqual({ ok: true, attachments: [] });
      // The deleted row is kept for its retention, then dropped by the sweep.
      expect(alarmAt(sql)).toBeGreaterThan(Date.now() + ATTACHMENT_DELETED_KEEP_MS - 60_000);
    }, f);
  });
});

describe("who may (section 6)", () => {
  it("uploads: a member or a key, to a session they may write or one Org does not hold yet; never an agent or the platform", async () => {
    await withActor("at-who-up", async (org) => {
      const a = member("usr_a", "at-who-up");
      const b = member("usr_b", "at-who-up");
      // The organization's default access is `owner`: b does not see a's session.
      await owned(org, a);
      expect(await org.attachmentCreate(b, SID, AT1, spec())).toMatchObject({ ok: false, code: "session_not_found", status: 404 });
      // Shared as a writer: allowed.
      await org.mutate(a, { name: "thread.writers", args: { sid: SID, writers: ["user:usr_a", "user:usr_b"] } });
      expect(await org.attachmentCreate(b, SID, AT1, spec())).toMatchObject({ ok: true, created: true, attachment: { by: "user:usr_b" } });
      // Open to the organization, with the owner its one writer: b reads but may not upload.
      await readersOnly(org, a);
      expect(await org.getSession(b, SID)).toMatchObject({ ok: true });
      expect(await org.attachmentCreate(b, SID, AT2, spec())).toMatchObject({ ok: false, code: "forbidden", status: 403, reason: "not_a_writer" });
      // A draft's session, not yet created: any member.
      expect(await org.attachmentCreate(b, DRAFT, AT2, spec())).toMatchObject({ ok: true, created: true });
      expect(await org.attachmentCreate({ ...a, kind: "key", via: "api" }, DRAFT, AT3, spec())).toMatchObject({ ok: true, created: true });
      expect(await org.attachmentCreate(agentOf(SID, "at-who-up"), SID, "at_0000000000000004", spec())).toMatchObject({ ok: false, code: "forbidden" });
      expect(await org.attachmentCreate(platform("at-who-up"), SID, "at_0000000000000004", spec())).toMatchObject({ ok: false, code: "forbidden" });
    });
  });

  it("reads: the uploader, one who reads the session, or the session's own agent; lists all to a reader, own uploads to the uploader", async () => {
    await withActor("at-who-read", async (org) => {
      const a = member("usr_a", "at-who-read");
      const b = member("usr_b", "at-who-read");
      const c = member("usr_c", "at-who-read");
      await owned(org, a);
      await org.mutate(a, { name: "thread.writers", args: { sid: SID, writers: ["user:usr_a", "user:usr_b"] } });
      await org.attachmentCreate(a, SID, AT1, spec());
      await org.attachmentReady(AT1, '"1"');
      await org.attachmentCreate(b, SID, AT2, spec({ name: "b.txt" }));
      await org.attachmentReady(AT2, '"2"');
      // b is no longer on the session; its own upload stays visible to it, a's does not.
      await org.mutate(a, { name: "thread.writers", args: { sid: SID, writers: ["user:usr_a"] } });
      expect(await org.attachmentRead(b, SID, AT2)).toMatchObject({ ok: true, attachment: { id: AT2 } });
      expect(await org.attachmentRead(b, SID, AT1)).toMatchObject({ ok: false, code: "attachment_not_found", status: 404 });
      expect((await org.attachmentList(b, SID)) as { attachments: { id: string }[] }).toMatchObject({ attachments: [{ id: AT2 }] });
      // The owner reads both; a stranger neither; the session's own agent both, another session's agent none.
      expect(((await org.attachmentList(a, SID)) as { attachments: { id: string }[] }).attachments.map((x) => x.id)).toEqual([AT2, AT1]);
      expect(await org.attachmentRead(c, SID, AT1)).toMatchObject({ ok: false, code: "attachment_not_found" });
      expect(await org.attachmentList(c, SID)).toEqual({ ok: true, attachments: [] });
      expect(await org.attachmentRead(agentOf(SID, "at-who-read"), SID, AT1)).toMatchObject({ ok: true });
      expect(await org.attachmentRead(agentOf(DRAFT, "at-who-read"), SID, AT1)).toMatchObject({ ok: false, code: "attachment_not_found" });
      // Under another session's id the row is not found.
      expect(await org.attachmentRead(a, DRAFT, AT1)).toMatchObject({ ok: false, code: "attachment_not_found" });
    });
  });

  it("deletes: the uploader or a writer of the session, not a reader; never an attached one", async () => {
    await withActor("at-who-del", async (org) => {
      const a = member("usr_a", "at-who-del");
      const b = member("usr_b", "at-who-del");
      await owned(org, a);
      await org.mutate(a, { name: "thread.writers", args: { sid: SID, writers: ["user:usr_a", "user:usr_b"] } });
      await org.attachmentCreate(b, SID, AT1, spec());
      await org.attachmentReady(AT1, '"1"');
      await org.attachmentCreate(b, SID, AT2, spec());
      await org.attachmentReady(AT2, '"2"');
      // The owner (a writer) deletes b's upload.
      expect(await org.attachmentDelete(a, SID, AT1)).toEqual({ ok: true });
      // A reader who is not a writer may not delete another's; its own, yes.
      await readersOnly(org, a);
      await org.attachmentCreate(a, SID, AT3, spec());
      await org.attachmentReady(AT3, '"3"');
      expect(await org.attachmentDelete(b, SID, AT3)).toMatchObject({ ok: false, code: "forbidden", status: 403, reason: "not_a_writer" });
      expect(await org.attachmentDelete(b, SID, AT2)).toEqual({ ok: true });
      await org.attachmentCreate(a, SID, "at_0000000000000004", spec());
      await org.attachmentReady("at_0000000000000004", '"4"');
      expect(await org.attachmentReserve(a, SID, TURN, "msg_1", ["at_0000000000000004"])).toMatchObject({ ok: true });
      expect(await org.attachmentDelete(a, SID, "at_0000000000000004")).toMatchObject({ ok: false, code: "attachment_in_use", status: 409 });
    });
  });
});

describe("the quotas (section 8)", () => {
  it("refuses an upload past the session's bytes, then the organization's, and gives the bytes back on delete", async () => {
    await withActor("at-quota", async (org, _f, sql) => {
      const a = member("usr_a", "at-quota");
      await org.feed(a, {}); // the actor migrates on its first use
      seedThread(sql, SID, "usr_a");
      expect(await org.attachmentCreate(a, SID, AT1, spec({ bytes: ATTACHMENT_SESSION_BYTES_MAX }))).toMatchObject({ ok: true });
      expect(await org.attachmentCreate(a, SID, AT2, spec({ bytes: 1 }))).toMatchObject({ ok: false, code: "attachment_quota", status: 429, limit: "session", max: ATTACHMENT_SESSION_BYTES_MAX });
      expect(bytesOf(sql, SID)).toBe(ATTACHMENT_SESSION_BYTES_MAX);
      // Full sessions up to the organization's limit; the next byte is refused.
      for (let n = 1; n < ATTACHMENT_ORG_BYTES_MAX / ATTACHMENT_SESSION_BYTES_MAX; n++) {
        expect(await org.attachmentCreate(a, `cs_1${String(n).padStart(15, "0")}`, `at_1${String(n).padStart(15, "0")}`, spec({ bytes: ATTACHMENT_SESSION_BYTES_MAX }))).toMatchObject({ ok: true });
      }
      expect(await org.attachmentCreate(a, DRAFT, AT3, spec({ bytes: 1 }))).toMatchObject({ ok: false, code: "attachment_quota", limit: "organization" });
      expect(await org.attachmentDelete(a, SID, AT1)).toEqual({ ok: true });
      expect(bytesOf(sql, SID)).toBe(0);
      expect(await org.attachmentCreate(a, DRAFT, AT3, spec({ bytes: 1 }))).toMatchObject({ ok: true });
    });
  });
});

describe("a turn's attachments: reserve (section 6, D5)", () => {
  it("attaches ready rows to the turn, all or none, in the order given; another turn may name them again", async () => {
    await withActor("at-reserve", async (org, _f, sql) => {
      const a = member("usr_a", "at-reserve");
      await org.feed(a, {}); // the actor migrates on its first use
      seedThread(sql, SID, "usr_a");
      await org.attachmentCreate(a, SID, AT1, spec({ name: "one.png", mimetype: "image/png", bytes: 3 }));
      await org.attachmentReady(AT1, '"1"');
      await org.attachmentCreate(a, SID, AT2, spec({ name: "two.txt" }));
      // Not ready yet: nothing is attached.
      expect(await org.attachmentReserve(a, SID, TURN, null, [AT1, AT2])).toMatchObject({ ok: false, code: "attachment_not_ready", status: 409, attachmentId: AT2 });
      expect(await org.attachmentRead(a, SID, AT1)).toMatchObject({ ok: true, attachment: { state: "ready" } });
      await org.attachmentReady(AT2, '"2"');
      expect(await org.attachmentReserve(a, SID, TURN, "msg_1", [AT2, AT1])).toEqual({
        ok: true,
        attachments: [
          { id: AT2, name: "two.txt", mimetype: "text/plain", bytes: 12 },
          { id: AT1, name: "one.png", mimetype: "image/png", bytes: 3 },
        ],
      });
      expect(await org.attachmentRead(a, SID, AT1)).toMatchObject({ ok: true, attachment: { state: "attached", attachedTo: { turnId: TURN, messageId: "msg_1" } } });
      // The same turn again is a retry. Another turn carries it as well (a send that was not accepted is sent
      // again under a new id, a forwarded file): it stays with the first turn that named it.
      expect(await org.attachmentReserve(a, SID, TURN, "msg_1", [AT1])).toMatchObject({ ok: true });
      expect(await org.attachmentReserve(a, SID, "tn_000000000002", null, [AT1])).toEqual({ ok: true, attachments: [{ id: AT1, name: "one.png", mimetype: "image/png", bytes: 3 }] });
      expect(await org.attachmentRead(a, SID, AT1)).toMatchObject({ ok: true, attachment: { state: "attached", attachedTo: { turnId: TURN, messageId: "msg_1" } } });
      // Attached: `ready` and the same create answer the row as it is.
      expect(await org.attachmentReady(AT1, '"3"')).toMatchObject({ ok: true, attachment: { state: "attached", etag: '"1"' } });
      expect(await org.attachmentCreate(a, SID, AT1, spec({ name: "one.png", mimetype: "image/png", bytes: 3 }))).toMatchObject({ ok: true, created: false, attachment: { state: "attached" } });
      // All or none: one unknown id, and the ready row named with it stays ready.
      await org.attachmentCreate(a, SID, AT3, spec({ name: "three.txt" }));
      await org.attachmentReady(AT3, '"3"');
      expect(await org.attachmentReserve(a, SID, "tn_000000000002", null, [AT3, "at_0000000000000009"])).toMatchObject({ ok: false, code: "attachment_not_found", attachmentId: "at_0000000000000009" });
      expect(await org.attachmentRead(a, SID, AT3)).toMatchObject({ ok: true, attachment: { state: "ready", attachedTo: null } });
      expect(sql.exec("SELECT purpose FROM _alarm WHERE purpose = 'attachments'")).toEqual([]);
    });
  });

  it("is the writer's: a non-writer, the platform, and another's upload whose uploader no longer writes are refused", async () => {
    await withActor("at-reserve-who", async (org) => {
      const a = member("usr_a", "at-reserve-who");
      const b = member("usr_b", "at-reserve-who");
      await owned(org, a);
      await org.mutate(a, { name: "thread.writers", args: { sid: SID, writers: ["user:usr_a", "user:usr_b"] } });
      await org.attachmentCreate(b, SID, AT1, spec());
      await org.attachmentReady(AT1, '"1"');
      expect(await org.attachmentReserve(platform("at-reserve-who"), SID, TURN, null, [AT1])).toMatchObject({ ok: false, code: "forbidden" });
      expect(await org.attachmentReserve(member("usr_c", "at-reserve-who"), SID, TURN, null, [AT1])).toMatchObject({ ok: false, code: "session_not_found" });
      // b's upload goes into a's turn while b writes; not once b only reads.
      await readersOnly(org, a);
      expect(await org.attachmentReserve(b, SID, TURN, null, [AT1])).toMatchObject({ ok: false, code: "forbidden", reason: "not_a_writer" });
      expect(await org.attachmentReserve(a, SID, TURN, null, [AT1])).toMatchObject({ ok: false, code: "attachment_not_found", attachmentId: AT1 });
      // A draft's session takes a member's own uploads, not an agent's.
      await org.attachmentCreate(a, SID, AT2, spec());
      await org.attachmentReady(AT2, '"2"');
      // The session's own agent reads its attachments (section 6) but is no writer of its own turns.
      expect(await org.attachmentRead(agentOf(SID, "at-reserve-who"), SID, AT2)).toMatchObject({ ok: true });
      expect(await org.attachmentReserve(agentOf(SID, "at-reserve-who"), SID, TURN, null, [AT2])).toMatchObject({ ok: false, code: "forbidden", reason: "not_a_writer" });
      await org.attachmentCreate(a, DRAFT, AT3, spec());
      await org.attachmentReady(AT3, '"3"');
      expect(await org.attachmentReserve(a, DRAFT, TURN, null, [AT3])).toMatchObject({ ok: true, attachments: [{ id: AT3 }] });
      expect(await org.attachmentReserve(agentOf(SID, "at-reserve-who"), DRAFT, TURN, null, [AT3])).toMatchObject({ ok: false, code: "session_not_found" });
    });
  });

  it("hands the first turn's attachments to the session's create, into the accept Org owes", async () => {
    const f = fakes();
    await withActor("at-create", async (org, _f, sql) => {
      const a = member("usr_a", "at-create");
      await org.attachmentCreate(a, SID, AT1, spec());
      await org.attachmentReady(AT1, '"1"');
      const reserved = await org.attachmentReserve(a, SID, "tn_000000000000", null, [AT1]);
      if (!reserved.ok) throw new Error(reserved.code);
      expect(await org.createSession(a, { id: SID, input: "Read this", attachments: reserved.attachments })).toMatchObject({ ok: true });
      await org.drain();
      const accept = f.calls.find((c) => c[0] === "SessionLog.accept")![1] as { body: unknown };
      expect(accept.body).toEqual({ input: "Read this", ifBusy: "queue", attachments: [{ id: AT1, name: "notes.txt", mimetype: "text/plain", bytes: 12 }] });
      // The reserve armed the sweep for a row whose session did not exist yet; the session now does: the sweep leaves it and disarms.
      sql.exec("UPDATE _alarm SET at = 0 WHERE purpose = 'attachments'");
      await org.alarm();
      expect(await org.attachmentRead(a, SID, AT1)).toMatchObject({ ok: true, attachment: { state: "attached" } });
      expect(sql.exec("SELECT purpose FROM _alarm WHERE purpose = 'attachments'")).toEqual([]);
    }, f);
  });
});

describe("the sweep on Org's alarm, and a session's removal (sections 3, 8)", () => {
  it("deletes an upload older than a day and a ready row whose session never came to be; drops a deleted row past its keep", async () => {
    const f = fakes();
    await withActor("at-sweep", async (org, _f, sql) => {
      const a = member("usr_a", "at-sweep");
      await org.feed(a, {}); // the actor migrates on its first use
      seedThread(sql, SID, "usr_a");
      const now = Date.now();
      await org.attachmentCreate(a, SID, AT1, spec()); // uploading, stale
      await org.attachmentCreate(a, DRAFT, AT2, spec()); // ready, orphan
      await org.attachmentReady(AT2, '"2"');
      await org.attachmentCreate(a, SID, AT3, spec()); // ready in a live session: kept
      await org.attachmentReady(AT3, '"3"');
      await org.attachmentCreate(a, SID, "at_0000000000000004", spec()); // deleted, past its keep
      await org.attachmentReady("at_0000000000000004", '"4"');
      await org.attachmentDelete(a, SID, "at_0000000000000004");
      await org.drain();
      f.attachments.deleted.length = 0;
      sql.exec("UPDATE attachment SET state_at = ? WHERE id = ?", now - ATTACHMENT_UPLOADING_TTL_MS - 1, AT1);
      sql.exec("UPDATE attachment SET state_at = ? WHERE id = ?", now - ATTACHMENT_ORPHAN_TTL_MS - 1, AT2);
      sql.exec("UPDATE attachment SET state_at = ? WHERE id = ?", now - ATTACHMENT_ORPHAN_TTL_MS - 1, AT3);
      sql.exec("UPDATE attachment SET state_at = ? WHERE id = ?", now - ATTACHMENT_DELETED_KEEP_MS - 1, "at_0000000000000004");
      sql.exec("UPDATE _alarm SET at = 0 WHERE purpose = 'attachments'");
      await org.alarm();
      expect(sql.exec("SELECT id, state FROM attachment ORDER BY id")).toEqual([
        { id: AT1, state: "deleted" },
        { id: AT2, state: "deleted" },
        { id: AT3, state: "ready" },
      ]);
      await org.drain();
      expect(f.attachments.deleted.sort()).toEqual([`at-sweep/${SID}/${AT1}`, `at-sweep/${DRAFT}/${AT2}`]);
      // Re-armed for the deleted rows' keep.
      expect(alarmAt(sql)).toBeGreaterThan(now + ATTACHMENT_DELETED_KEEP_MS - ATTACHMENT_UPLOADING_TTL_MS - 60_000);
    }, f);
  });

  it("removes a session's rows with the session and owes one delete of all its objects", async () => {
    const f = fakes();
    await withActor("at-remove", async (org, _f, sql) => {
      const a = member("usr_a", "at-remove");
      await org.feed(a, {}); // the actor migrates on its first use
      seedThread(sql, SID, "usr_a");
      await org.attachmentCreate(a, SID, AT1, spec());
      await org.attachmentReady(AT1, '"1"');
      await org.attachmentCreate(a, SID, AT2, spec());
      await org.attachmentReady(AT2, '"2"');
      await org.attachmentDelete(a, SID, AT2);
      // The write's own flush drains the delete it owed; what follows is the session's removal alone.
      await org.drain();
      f.attachments.deleted.length = 0;
      expect(await org.mutate(a, { name: "thread.delete", args: { sid: SID } })).toMatchObject({ protocol: 1 });
      expect(sql.exec("SELECT id FROM attachment WHERE session_id = ?", SID)).toEqual([]);
      // The single row's delete is dropped for the session's one removeAll.
      expect(owedCalls(sql)).toEqual([{ call: "Attachments.removeAll", key: `attachments:${SID}` }]);
      await org.drain();
      expect(f.attachments.deleted).toEqual([]);
      expect(f.attachments.removed).toEqual([`at-remove/${SID}/`]);
      expect(await org.attachmentRead(a, SID, AT1)).toMatchObject({ ok: false, code: "attachment_not_found" });
    }, f);
  });
});
