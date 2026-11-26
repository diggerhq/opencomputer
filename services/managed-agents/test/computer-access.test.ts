import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { type Access, type Actor, can, commandAction, decodeDrivers, role, stateText } from "../src/actors/computer/copied/access.js";
import { accessView, decodeAccessId, encodeAccessId, requestPost } from "../src/actors/computer/copied/access-views.js";

/**
 * Work 112: session roles. access.ts and access-views.ts are byte-identical copies of calvin's
 * (computer/src/), whose access.test.ts and access-views.test.ts hold the full tables; here, that the
 * copies match and that they run in this package.
 */
describe("session access, shared with calvin", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const name of ["access.ts", "access-views.ts"]) {
    const theirs = join(here, "../../../computer/src", name);
    it.skipIf(!existsSync(theirs))(`${name} is calvin's, byte for byte`, () => {
      expect(readFileSync(join(here, "../src/actors/computer/copied", name), "utf8")).toBe(readFileSync(theirs, "utf8"));
    });
  }

  const a: Access = { owner: "UOWNER01", drivers: ["ULISTED1"] };
  const member: Actor = { id: "UMEMBER1", member: true, admin: false };
  const admin: Actor = { id: "UADMIN01", member: true, admin: true };
  const guest: Actor = { id: "UGUEST01", member: false, admin: false };

  it("decides roles and actions", () => {
    expect(role(a, member)).toBe("participant");
    expect(role(a, guest)).toBe("outsider");
    expect(can(a, member, "instruct")).toBe(false);
    expect(can(a, member, "request")).toBe(true);
    expect(can(a, admin, "grant")).toBe(true);
    expect(commandAction("!mode plan")).toBe("settings");
    expect(decodeDrivers("not json")).toEqual([]);
    expect(stateText(a)).toBe("Runs as <@UOWNER01>. They and <@ULISTED1> can drive.");
  });

  it("encodes button ids as the runner's prompt ids do, and builds the views", () => {
    const key = "T1:C2:1791495325.000001";
    expect(encodeAccessId(key, "allow", "U1")).toBe(`ac:${Buffer.from(key).toString("base64url")}:allow:U1`);
    expect(decodeAccessId(encodeAccessId(key, "deny", "U1"))).toEqual({ sessionKey: key, verb: "deny", userId: "U1" });
    expect(requestPost(key, "UOWNER01", "UMEMBER1").blocks).toHaveLength(2);
    expect(accessView(key, a, member)?.close.text).toBe("Close");
    expect(accessView(key, a, guest)).toBeUndefined();
  });
});
