import { describe, expect, it } from "vitest";

import {
  ACCESS_USAGE,
  defaultChangedText,
  noSessionText,
  notMemberText,
  onlyAdminDefaultText,
  onlyGrantorChangesText,
  pickSomeoneText,
  stateText,
  tooManyPeopleText,
} from "../src/computer/access.js";
import { ACCESS_VIEW, encodeAccessId } from "../src/computer/access-views.js";
import { A, ADMIN, B, GUEST, KEY, OWNER, accessHarness } from "./fixtures/computer-access.js";

const where = (userId: string) => ({ userId, channelId: "C1", threadTs: "100.1" });
const inSession = (userId: string) => ({ ...where(userId), session: { key: KEY } });
const blocksOf = (body: Record<string, unknown> | undefined) => (body?.blocks ?? []) as Array<{ type: string; elements?: Array<{ action_id: string }> }>;

describe("session roles: !access (work 112)", () => {
  it("shows the state to anyone who can view, with Change… only for someone who can grant", async () => {
    const h = accessHarness([A]);
    await h.ui.command("!access", inSession(B));
    await h.ui.command("!access", inSession(OWNER));
    const [participant, own] = h.of("chat.postEphemeral");
    expect(participant).toMatchObject({ user: B, thread_ts: "100.1", text: stateText({ owner: OWNER, drivers: [A] }) });
    expect(blocksOf(participant).map((b) => b.type)).toEqual(["section"]);
    expect(blocksOf(own)[1]!.elements![0]!.action_id).toBe(encodeAccessId(KEY, "open"));
    // An outsider cannot view.
    await h.ui.command("!access", inSession(GUEST));
    expect(h.ephemerals(GUEST)).toEqual([onlyGrantorChangesText(OWNER)]);
  });

  it("open, owner, a list, add and remove change drivers through setDrivers and answer S10", async () => {
    const h = accessHarness("*");
    await h.ui.command(`!access @${A} @${B}`, inSession(OWNER));
    expect(h.store.drivers(KEY)).toEqual([A, B]);
    await h.ui.command(`!access remove @${A}`, inSession(OWNER));
    expect(h.store.drivers(KEY)).toEqual([B]);
    await h.ui.command(`!access add @${A}`, inSession(OWNER));
    expect(h.store.drivers(KEY)).toEqual([A, B]);
    await h.ui.command("!access owner", inSession(OWNER));
    expect(h.store.drivers(KEY)).toEqual([]);
    await h.ui.command("!access open", inSession(OWNER));
    expect(h.store.drivers(KEY)).toBe("*");
    expect(h.ephemerals(OWNER).at(-1)).toBe(stateText({ owner: OWNER, drivers: "*" }));
    expect(h.changes).toHaveLength(5);
  });

  it("without grant: S11 and nothing changes; an admin may", async () => {
    const h = accessHarness([A]);
    await h.ui.command("!access open", inSession(A));
    expect(h.ephemerals(A)).toEqual([onlyGrantorChangesText(OWNER)]);
    expect(h.store.drivers(KEY)).toEqual([A]);
    await h.ui.command("!access open", inSession(ADMIN));
    expect(h.store.drivers(KEY)).toBe("*");
    expect(h.changes[0]!.by).toEqual({ id: ADMIN, admin: true });
  });

  it("a named person who is not a member answers the member error and changes nothing", async () => {
    const h = accessHarness([A]);
    await h.ui.command(`!access add @${GUEST}`, inSession(OWNER));
    expect(h.ephemerals(OWNER)).toEqual([notMemberText(`name-${GUEST}`)]);
    expect(h.store.drivers(KEY)).toEqual([A]);
  });

  it("more than 50 people are refused", async () => {
    const h = accessHarness([]);
    const many = Array.from({ length: 51 }, (_, i) => `@U${String(i).padStart(7, "0")}`).join(" ");
    await h.ui.command(`!access ${many}`, inSession(OWNER));
    expect(h.ephemerals(OWNER)).toEqual([tooManyPeopleText()]);
    expect(h.store.drivers(KEY)).toEqual([]);
  });

  it("any other form answers the usage", async () => {
    const h = accessHarness();
    await h.ui.command("!access everyone please", inSession(A));
    expect(h.ephemerals(A)).toEqual([ACCESS_USAGE]);
  });

  it("outside a session: S12; the default needs an admin who is a member, and works anywhere", async () => {
    const h = accessHarness();
    await h.ui.command("!access", where(A));
    expect(h.ephemerals(A)).toEqual([noSessionText()]);
    await h.ui.command("!access default owner", where(OWNER));
    expect(h.ephemerals(OWNER)).toEqual([onlyAdminDefaultText()]);
    expect(h.store.accessDefault()).toBe("open");
    await h.ui.command("!access default owner", { userId: ADMIN, channelId: "C2" });
    expect(h.store.accessDefault()).toBe("owner");
    const answer = h.of("chat.postEphemeral").at(-1);
    expect(answer).toEqual({ channel: "C2", user: ADMIN, text: defaultChangedText("owner") });
  });
});

describe("session roles: the modal (work 112)", () => {
  const submission = (who: string, people: string[] = [], key = KEY) => ({
    callback_id: ACCESS_VIEW,
    private_metadata: JSON.stringify({ key }),
    state: { values: { who: { v: { selected_option: { value: who } } }, people: { v: { selected_users: people } } } },
  });

  it("Access opens the grantor view for the owner, the read-only one for a participant, nothing for an outsider", async () => {
    const h = accessHarness([A]);
    const open = encodeAccessId(KEY, "open");
    await h.ui.action(open, "trig", where(OWNER));
    await h.ui.action(open, "trig", where(B));
    await h.ui.action(open, "trig", where(GUEST));
    const views = h.of("views.open") as Array<{ trigger_id: string; view: { callback_id: string; submit?: unknown } }>;
    expect(views).toHaveLength(2);
    expect(views[0]).toMatchObject({ trigger_id: "trig", view: { callback_id: ACCESS_VIEW, submit: { text: "Save" } } });
    expect(views[1]!.view.submit).toBeUndefined();
  });

  it("Access for a session that is gone answers S12", async () => {
    const h = accessHarness();
    await h.ui.action(encodeAccessId("T1:C1:9.9", "open"), "trig", where(A));
    expect(h.ephemerals(A)).toEqual([noSessionText()]);
  });

  it("a request's buttons come back as work for after the ack", async () => {
    const h = accessHarness([]);
    const r = await h.ui.action(encodeAccessId(KEY, "allow", A), "trig", where(B));
    expect(h.calls).toEqual([]);
    await r.after!();
    // No request is open: B cannot grant, so S5.
    expect(h.ephemerals(B)).toHaveLength(1);
  });

  it("Save re-checks grant, refuses nobody and non-members, then sets drivers", async () => {
    const h = accessHarness("*");
    expect(await h.ui.submit(submission("owner"), A)).toEqual({ errors: { who: onlyGrantorChangesText(OWNER) } });
    expect(await h.ui.submit(submission("people", [OWNER]), OWNER)).toEqual({ errors: { people: pickSomeoneText() } });
    expect(await h.ui.submit(submission("people", [A, GUEST]), OWNER)).toEqual({ errors: { people: notMemberText(`name-${GUEST}`) } });
    expect(await h.ui.submit(submission("people", [A], "T1:C1:9.9"), OWNER)).toEqual({ errors: { who: noSessionText() } });
    expect(h.store.drivers(KEY)).toBe("*");
    const ok = await h.ui.submit(submission("people", [B, A, OWNER]), OWNER);
    expect(ok.errors).toBeUndefined();
    await ok.after!();
    expect(h.store.drivers(KEY)).toEqual([A, B]);
    // Nothing else is posted for a restriction.
    expect(h.posts()).toEqual([]);
  });
});
