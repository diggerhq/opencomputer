import { describe, expect, it } from "vitest";

import {
  ACCESS_USAGE,
  driversCommandText,
  grantedText,
  notAskedText,
  onlyGrantorAnswersText,
  onlyMembersText,
  openedText,
  ownerCommandText,
  ownerDecidesText,
  requestSentText,
  requestText,
  stoppedText,
  type Drivers,
} from "../src/computer/access.js";
import { declinedPost, encodeAccessId } from "../src/computer/access-views.js";
import { normalizeJob } from "../src/computer/slack.js";
import { LOOKUP_FAILED_TEXT } from "../src/computer/threads.js";
import { A, ADMIN, B, GUEST, KEY, OWNER, SESSION, STRANGER, accessHarness, drain, send } from "./fixtures/computer-access.js";

const ctx = (h: ReturnType<typeof accessHarness>) => h.store.held(KEY);
const owner = { id: OWNER, admin: false };

describe("session roles: messages (work 112)", () => {
  it("a participant's message is held as context and not delivered", async () => {
    const h = accessHarness([]);
    const gate = await send(h, h.job(A, "the logs say 503", { files: [{ id: "F1", name: "log.txt" }] }));
    expect(gate).toEqual({ deliver: false, reason: "held" });
    expect(h.delivered).toEqual([]);
    expect(ctx(h)).toMatchObject([{ userId: A, text: "the logs say 503", files: ["log.txt"] }]);
    // Not a mention: nothing is posted.
    expect(h.calls.filter((c) => c.method !== "users.info")).toEqual([]);
  });

  it("an outsider's message is dropped and never reaches context; a mention answers S14", async () => {
    const h = accessHarness("*");
    expect(await send(h, h.job(GUEST, "hi"))).toEqual({ deliver: false, reason: "outsider" });
    expect(await send(h, h.job(STRANGER, "do it", { mentioned: true }))).toEqual({ deliver: false, reason: "outsider" });
    expect(ctx(h)).toEqual([]);
    expect(h.delivered).toEqual([]);
    expect(h.ephemerals(GUEST)).toEqual([]);
    expect(h.ephemerals(STRANGER)).toEqual([onlyMembersText()]);
  });

  it("a participant's first mention posts S1 once with its buttons and answers S2; a second answers S2b and posts nothing", async () => {
    const h = accessHarness([]);
    await send(h, h.job(A, "please fix it", { mentioned: true }));
    const [post] = h.of("chat.postMessage");
    expect(post).toMatchObject({ channel: "C1", thread_ts: "100.1", text: requestText(OWNER, A) });
    const buttons = (post!.blocks as Array<{ elements?: Array<{ action_id: string }> }>)[1]!.elements!.map((e) => e.action_id);
    expect(buttons).toEqual([encodeAccessId(KEY, "allow", A), encodeAccessId(KEY, "deny", A)]);
    expect(h.ephemerals(A)).toEqual([requestSentText(OWNER)]);
    expect(h.store.request(KEY, A)).toMatchObject({ state: "open", messageTs: "300.1" });
    await send(h, h.job(A, "hello?", { mentioned: true }));
    expect(h.of("chat.postMessage")).toHaveLength(1);
    expect(h.ephemerals(A)).toEqual([requestSentText(OWNER), ownerDecidesText(OWNER)]);
    // Both are context.
    expect(ctx(h).map((m) => m.text)).toEqual(["please fix it", "hello?"]);
  });

  it("a request whose post failed is not recorded and answers nothing; the next mention asks again", async () => {
    const h = accessHarness([]);
    h.answers.set("chat.postMessage", { ok: false, error: "not_in_channel" });
    await send(h, h.job(A, "please", { mentioned: true }));
    expect(h.store.request(KEY, A)).toBeUndefined();
    expect(h.ephemerals(A)).toEqual([]);
    h.answers.delete("chat.postMessage");
    await send(h, h.job(A, "please?", { mentioned: true }));
    expect(h.store.request(KEY, A)).toMatchObject({ state: "open", messageTs: expect.stringMatching(/\.1$/) });
    expect(h.ephemerals(A)).toEqual([requestSentText(OWNER)]);
  });

  it("the rows are guards: a retried message is held once and asks once", async () => {
    const h = accessHarness([]);
    const job = h.job(A, "please fix it", { mentioned: true, messageTs: "250.1" });
    await send(h, job);
    await send(h, job);
    expect(ctx(h)).toHaveLength(1);
    expect(h.of("chat.postMessage")).toHaveLength(1);
    expect(h.ephemerals(A)).toEqual([requestSentText(OWNER)]);
  });

  it("only a mention at the message's start asks to drive; one mid-message is context only", async () => {
    const h = accessHarness([]);
    const inline = normalizeJob(h.job(A, "ask <@UBOT> later", { mentioned: true }), "UBOT")!;
    expect(inline).toMatchObject({ mentioned: true, mentionedInline: true });
    expect(normalizeJob(h.job(A, " <@UBOT> now"), "UBOT")).toMatchObject({ mentioned: true });
    expect(normalizeJob(h.job(A, " <@UBOT> now"), "UBOT")!.mentionedInline).toBeUndefined();
    expect(await send(h, inline)).toEqual({ deliver: false, reason: "held" });
    expect(h.of("chat.postMessage")).toEqual([]);
    expect(h.ephemerals(A)).toEqual([]);
    await send(h, normalizeJob(h.job(A, "<@UBOT> now"), "UBOT")!);
    expect(h.posts()).toEqual([requestText(OWNER, A)]);
  });

  it("one lookup of a person, cached; a failed one throws on a message (the queue retries) and says try again on a click", async () => {
    const h = accessHarness([]);
    h.answers.set("users.info", { ok: false, error: "ratelimited" });
    await expect(send(h, h.job(A, "note"))).rejects.toThrow();
    expect(ctx(h)).toEqual([]);
    await h.flow.answer(KEY, A, () => "x");
    expect(h.ephemerals(A)).toEqual([LOOKUP_FAILED_TEXT]);
    expect(await h.flow.stop(SESSION, A, () => true)).toBe(false);
    h.answers.delete("users.info");
    await send(h, h.job(A, "note"));
    await send(h, h.job(A, "another"));
    expect(ctx(h)).toHaveLength(2);
    // Three failures, none kept; then one answer kept for both messages.
    expect(h.of("users.info")).toHaveLength(4);
  });

  it("held context rides the next driver message, oldest first with names, and is deleted after", async () => {
    const h = accessHarness([]);
    await send(h, h.job(A, "first"));
    await send(h, h.job(B, "second"));
    await send(h, h.job(OWNER, "go"));
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]).toMatchObject({ userId: OWNER, role: "owner" });
    expect(h.delivered[0]!.linked).toEqual([
      {
        url: "",
        ok: true,
        where: "",
        context: true,
        messages: [
          { name: `name-${A}`, ts: expect.any(String), text: "first" },
          { name: `name-${B}`, ts: expect.any(String), text: "second" },
        ],
      },
    ]);
    expect(ctx(h)).toEqual([]);
    await send(h, h.job(OWNER, "again"));
    expect(h.delivered[1]!.linked).toBeUndefined();
  });

  it("a failed delivery keeps the context for the next message", async () => {
    const h = accessHarness([]);
    await send(h, h.job(A, "note"));
    h.failDelivery = true;
    await expect(send(h, h.job(OWNER, "go"))).rejects.toThrow("hub down");
    expect(ctx(h).map((m) => m.text)).toEqual(["note"]);
    h.failDelivery = false;
    await send(h, h.job(OWNER, "go"));
    expect(h.delivered[0]!.linked).toHaveLength(1);
    expect(ctx(h)).toEqual([]);
  });

  it("a driver in an open session delivers with role driver", async () => {
    const h = accessHarness("*");
    expect(await send(h, h.job(A, "do it"))).toEqual({ deliver: true, role: "driver", context: true });
    expect(h.delivered[0]).toMatchObject({ userId: A, role: "driver" });
  });

  it("`!mode` from a driver answers S7 and is not delivered", async () => {
    const h = accessHarness("*");
    expect(await send(h, h.job(A, "!mode plan"))).toEqual({ deliver: false, reason: "command_refused" });
    expect(h.ephemerals(A)).toEqual([ownerCommandText(OWNER, "mode")]);
    expect(h.delivered).toEqual([]);
  });

  it("other commands: S8 for a participant's `!diff`; `!stop` from a participant is delivered without context; nothing for an outsider's `!help`", async () => {
    const h = accessHarness([]);
    await send(h, h.job(B, "held"));
    expect(await send(h, h.job(A, "!diff"))).toEqual({ deliver: false, reason: "command_refused" });
    expect(h.ephemerals(A)).toEqual([driversCommandText("diff")]);
    expect(await send(h, h.job(A, "!stop"))).toEqual({ deliver: true, role: "participant", context: false });
    expect(h.delivered[0]).toMatchObject({ text: "!stop", role: "participant" });
    expect(h.delivered[0]!.linked).toBeUndefined();
    expect(ctx(h)).toHaveLength(1);
    expect(await send(h, h.job(GUEST, "!help"))).toEqual({ deliver: false, reason: "command_refused" });
    expect(h.ephemerals(GUEST)).toEqual([]);
  });

  it("the gateway's own commands read as instruct: S8 for a participant's `!secret`, through for a driver", async () => {
    const h = accessHarness([B]);
    expect(await send(h, h.job(A, "!secret set TOKEN"))).toEqual({ deliver: false, reason: "command_refused" });
    expect(h.ephemerals(A)).toEqual([driversCommandText("secret")]);
    expect(await h.flow.message(h.job(B, "!var X=1"), "!var X=1", SESSION)).toEqual({ deliver: true, role: "driver", context: false });
  });
});

describe("session roles: requests to drive (work 112)", () => {
  async function requested() {
    const h = accessHarness([]);
    await send(h, h.job(A, "please fix it", { mentioned: true, messageTs: "250.1" }));
    return h;
  }

  it("Allow by anyone who cannot grant answers S5 and changes nothing, the requester included", async () => {
    const h = await requested();
    await h.flow.answerRequest(KEY, "allow", A, A);
    await h.flow.answerRequest(KEY, "allow", A, B);
    expect(h.ephemerals(A).at(-1)).toBe(onlyGrantorAnswersText(OWNER));
    expect(h.ephemerals(B)).toEqual([onlyGrantorAnswersText(OWNER)]);
    expect(h.store.drivers(KEY)).toEqual([]);
    expect(h.store.request(KEY, A)?.state).toBe("open");
    expect(h.of("chat.update")).toEqual([]);
  });

  it("Allow by the owner adds the driver, edits the request to S3 and puts the held message back on the queue, where it runs once as theirs", async () => {
    const h = await requested();
    await send(h, h.job(B, "unrelated note"));
    await h.flow.answerRequest(KEY, "allow", A, OWNER);
    expect(h.store.drivers(KEY)).toEqual([A]);
    expect(h.store.request(KEY, A)?.state).toBe("closed");
    expect(h.of("chat.update")).toEqual([{ channel: "C1", ts: "300.1", text: grantedText(owner, [A], OWNER), blocks: [] }]);
    expect(h.delivered).toEqual([]);
    expect(h.requeued).toMatchObject([{ userId: A, text: "please fix it", messageTs: "250.1", mentioned: true }]);
    // The request's own message is no longer context; the queue gates it again.
    expect(ctx(h).map((m) => m.text)).toEqual(["unrelated note"]);
    expect(await drain(h)).toEqual([{ deliver: true, role: "driver", context: true }]);
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]).toMatchObject({ userId: A, text: "please fix it", messageTs: "250.1", role: "driver" });
    // The other participant's note rides along, once.
    expect(h.delivered[0]!.linked).toMatchObject([{ context: true, messages: [{ text: "unrelated note" }] }]);
    expect(ctx(h)).toEqual([]);
    // Step 4 handled A: no second S3 in the thread.
    expect(h.posts()).toEqual([requestText(OWNER, A)]);
    // A second click on the same request does nothing.
    await h.flow.answerRequest(KEY, "allow", A, OWNER);
    expect(h.requeued).toEqual([]);
  });

  it("Allow when everyone drives already answers the request and runs its message, without a special case", async () => {
    const h = await requested();
    h.store.writeDrivers(KEY, "*");
    await h.flow.answerRequest(KEY, "allow", A, OWNER);
    expect(h.store.request(KEY, A)?.state).toBe("closed");
    expect(h.requeued).toHaveLength(1);
    expect(h.of("chat.update")).toHaveLength(1);
    expect(h.changes).toEqual([]);
  });

  it("Allow for someone who is no longer a member tells the clicker and leaves the request open", async () => {
    const h = accessHarness([]);
    // Held while a member (the lookup is cached ten minutes); a guest by the time of the click.
    await h.flow.message(h.job(GUEST, "x", { mentioned: true }), "x", SESSION);
    expect(h.posts()).toEqual([]);
    h.store.addRequest(KEY, GUEST, JSON.stringify(h.job(GUEST, "x")));
    await h.flow.answerRequest(KEY, "allow", GUEST, OWNER);
    expect(h.ephemerals(OWNER)).toEqual([`name-${GUEST} can’t be added: only full members of this workspace can drive.`]);
    expect(h.store.request(KEY, GUEST)?.state).toBe("open");
    expect(h.store.drivers(KEY)).toEqual([]);
  });

  it("Allow by an admin who is not the owner says so", async () => {
    const h = await requested();
    await h.flow.answerRequest(KEY, "allow", A, ADMIN);
    expect(h.of("chat.update")[0]!.text).toBe(grantedText({ id: ADMIN, admin: true }, [A], OWNER));
    expect(h.changes).toEqual([{ key: KEY, by: { id: ADMIN, admin: true }, from: "[]", to: `["${A}"]` }]);
  });

  it("Not now closes the request, edits it to S4, keeps the message as context; a later mention answers S2b", async () => {
    const h = await requested();
    await h.flow.answerRequest(KEY, "deny", A, OWNER);
    expect(h.store.request(KEY, A)?.state).toBe("closed");
    expect(h.of("chat.update")).toEqual([{ channel: "C1", ts: "300.1", ...declinedPost(A) }]);
    expect(ctx(h).map((m) => m.text)).toEqual(["please fix it"]);
    await send(h, h.job(A, "again", { mentioned: true }));
    expect(h.ephemerals(A).at(-1)).toBe(ownerDecidesText(OWNER));
    expect(h.of("chat.postMessage")).toHaveLength(1);
    expect(h.store.drivers(KEY)).toEqual([]);
  });

  it("opening the session answers open requests and delivers their messages", async () => {
    const h = await requested();
    await h.flow.setDrivers(KEY, () => "*", owner);
    expect(h.store.request(KEY, A)?.state).toBe("closed");
    expect(h.requeued).toHaveLength(1);
    expect(h.posts()).toEqual([requestText(OWNER, A), openedText(owner, OWNER)]);
  });
});

describe("session roles: setDrivers (work 112)", () => {
  it("the same value does nothing at all", async () => {
    const h = accessHarness([A]);
    await h.flow.setDrivers(KEY, () => [A, OWNER, A], owner);
    expect(h.calls).toEqual([]);
    expect(h.changes).toEqual([]);
  });

  it("restricting writes, adds the marker and posts nothing", async () => {
    const h = accessHarness("*");
    await h.flow.setDrivers(KEY, () => [B, A, OWNER], owner);
    expect(h.store.drivers(KEY)).toEqual([A, B]);
    expect(h.of("reactions.add")).toEqual([{ channel: "C1", timestamp: "100.1", name: "lock" }]);
    expect(h.posts()).toEqual([]);
    expect(h.changes).toEqual([{ key: KEY, by: owner, from: "*", to: JSON.stringify([A, B]) }]);
  });

  it("opening a restricted session removes the marker and posts S3b", async () => {
    const h = accessHarness([]);
    await h.flow.setDrivers(KEY, () => "*", owner);
    expect(h.of("reactions.remove")).toEqual([{ channel: "C1", timestamp: "100.1", name: "lock" }]);
    expect(h.posts()).toEqual([openedText(owner, OWNER)]);
  });

  it("adding people to a list posts S3 once naming them; removing posts nothing; the marker stays", async () => {
    const h = accessHarness([A]);
    await h.flow.setDrivers(KEY, () => [A, B, ADMIN], owner);
    expect(h.posts()).toEqual([grantedText(owner, [ADMIN, B], OWNER)]);
    await h.flow.setDrivers(KEY, () => [], owner);
    expect(h.posts()).toHaveLength(1);
    expect(h.of("reactions.add")).toEqual([]);
    expect(h.of("reactions.remove")).toEqual([]);
    expect(h.changes.map((c) => c.to)).toEqual([JSON.stringify([A, ADMIN, B].sort()), "[]"]);
  });

  it("refusals come back for the caller to word: not a member, too many, a form that does not apply, no session", async () => {
    const h = accessHarness([A]);
    expect(await h.flow.setDrivers(KEY, (d) => (d === "*" ? d : [...d, GUEST]), owner)).toEqual({ refused: "member", id: GUEST });
    expect(await h.flow.setDrivers(KEY, () => [STRANGER], owner)).toEqual({ refused: "member", id: STRANGER });
    const many = Array.from({ length: 51 }, (_, i) => `U${String(i).padStart(7, "0")}`);
    expect(await h.flow.setDrivers(KEY, () => many, owner)).toEqual({ refused: "limit" });
    expect(await h.flow.setDrivers(KEY, () => undefined, owner)).toEqual({ refused: "usage" });
    expect(await h.flow.refusalText({ refused: "usage" })).toBe(ACCESS_USAGE);
    expect(await h.flow.setDrivers("T1:C9:1.1", () => "*", owner)).toEqual({ refused: "gone" });
    expect(h.store.drivers(KEY)).toEqual([A]);
    expect(h.changes).toEqual([]);
    // Too many is refused before anyone is looked up.
    expect(h.of("users.info").map((b) => b.user)).toEqual([GUEST, STRANGER]);
  });

  it("only people it adds are looked up, together, and an edit made meanwhile is not lost", async () => {
    const h = accessHarness([A]);
    const add = (id: string) => (d: Drivers) => (d === "*" ? undefined : [...d, id]);
    await Promise.all([h.flow.setDrivers(KEY, add(B), owner), h.flow.setDrivers(KEY, add(ADMIN), owner)]);
    expect(h.store.drivers(KEY)).toEqual([ADMIN, A, B].sort());
    expect(h.of("users.info").map((b) => b.user).sort()).toEqual([ADMIN, B].sort());
  });

  it("a marker that is already there (or a refused one) does not fail the change", async () => {
    const h = accessHarness("*");
    h.answers.set("reactions.add", { ok: false, error: "already_reacted" });
    await h.flow.setDrivers(KEY, () => [], owner);
    h.answers.set("reactions.remove", { ok: false, error: "missing_scope" });
    await h.flow.setDrivers(KEY, () => "*", owner);
    expect(h.store.drivers(KEY)).toBe("*");
    expect(h.changes).toHaveLength(2);
  });
});

describe("session roles: new sessions (work 112)", () => {
  it("a new session under accessDefault = owner is [] with a marker; under the default it is open with none", async () => {
    const h = accessHarness();
    h.store.setAccessDefault("owner");
    h.addSession("T1:C1:500.1", OWNER, "500.1");
    h.flow.start("T1:C1:500.1");
    await h.settle();
    expect(h.store.drivers("T1:C1:500.1")).toEqual([]);
    expect(h.of("reactions.add")).toEqual([{ channel: "C1", timestamp: "500.1", name: "lock" }]);
    h.store.setAccessDefault("open");
    h.addSession("T1:C1:600.1", OWNER, "600.1");
    h.flow.start("T1:C1:600.1");
    await h.settle();
    expect(h.store.drivers("T1:C1:600.1")).toBe("*");
    expect(h.of("reactions.add")).toHaveLength(1);
  });

  it("a spawned session copies its parent's drivers, not the default", async () => {
    const h = accessHarness([A]);
    h.addSession("T1:C1:700.1", OWNER, "700.1");
    h.flow.start("T1:C1:700.1", KEY);
    await h.settle();
    expect(h.store.drivers("T1:C1:700.1")).toEqual([A]);
    expect(h.of("reactions.add")).toEqual([{ channel: "C1", timestamp: "700.1", name: "lock" }]);
  });
});

describe("session roles: stop and prompts (work 112)", () => {
  it("stop by an outsider is ignored; by a participant it stops and posts S9; by the owner or without a user it posts nothing", async () => {
    const h = accessHarness([]);
    const stops: string[] = [];
    const stop = (who: string) => () => (stops.push(who), true);
    expect(await h.flow.stop(SESSION, GUEST, stop(GUEST))).toBe(false);
    expect(await h.flow.stop(SESSION, A, stop(A))).toBe(true);
    expect(await h.flow.stop(SESSION, OWNER, stop(OWNER))).toBe(true);
    expect(await h.flow.stop(SESSION, undefined, stop("nobody"))).toBe(true);
    expect(stops).toEqual([A, OWNER, "nobody"]);
    expect(h.posts()).toEqual([stoppedText(A)]);
  });

  it("a stop the hub did not take posts nothing", async () => {
    const h = accessHarness([]);
    expect(await h.flow.stop(SESSION, A, () => false)).toBe(false);
    expect(h.posts()).toEqual([]);
  });

  it("a prompt click needs answer: a participant gets S6 and nothing is sent; a driver's frame carries their role", async () => {
    const h = accessHarness([B]);
    const sent: Array<string | undefined> = [];
    const frame = (role?: string) => (sent.push(role), `id-${sent.length}`);
    await h.flow.answer(KEY, A, frame);
    expect(sent).toEqual([]);
    expect(h.ephemerals(A)).toEqual([notAskedText(OWNER)]);
    await h.flow.answer(KEY, B, frame);
    await h.flow.answer(KEY, OWNER, frame);
    expect(sent).toEqual(["driver", "owner"]);
    // The runner refused B's click: S6 to B; the owner's passed.
    await h.flow.answered("id-1", "not-asked");
    await h.flow.answered("id-2", undefined);
    expect(h.ephemerals(B)).toEqual([notAskedText(OWNER)]);
    expect(h.ephemerals(OWNER)).toEqual([]);
  });

  it("a prompt in a session with no owner is sent as before, without a role", async () => {
    const h = accessHarness();
    const sent: Array<string | undefined> = [];
    await h.flow.answer("T1:C9:1.1", A, (role) => (sent.push(role), "x"));
    expect(sent).toEqual([undefined]);
  });
});
