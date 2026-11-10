import { describe, expect, it } from "vitest";
import { narrowestGrantedConnections, reachableGrantedConnections } from "../src/edge/computer-grants.js";
import type { ComputerGrantScope, ComputerServiceAttachment, Connection } from "../src/protocol.js";

function grant(
  id: string,
  label: string,
  scope: ComputerGrantScope,
  subject = "",
  service = "linear",
): ComputerServiceAttachment {
  return {
    service,
    provider: service,
    label,
    connectionId: id,
    connection: { id, label, provider: "linear" } as Connection,
    scope,
    subject,
    grantedBy: "user_1",
    createdAt: "",
    updatedAt: "",
  };
}

const audience = { sessionKey: "T1:C1:1.1", ownerId: "U1" };
const ids = (connections: Connection[]) => connections.map((c) => c.id);

describe("computer connection grants (work 080)", () => {
  const grants = [
    grant("everyone", "team", "everyone"),
    grant("mine", "personal", "user", "U1"),
    grant("theirs", "personal", "user", "U2"),
    grant("thread", "thread", "session", "T1:C1:1.1"),
    grant("other-thread", "thread", "session", "T1:C1:2.2"),
  ];

  it("uses the narrowest audience with a grant: this thread, then its owner, then everyone", () => {
    expect(ids(narrowestGrantedConnections(grants, audience))).toEqual(["thread"]);
    expect(ids(narrowestGrantedConnections(grants.filter((g) => g.scope !== "session"), audience))).toEqual(["mine"]);
    expect(ids(narrowestGrantedConnections(grants.filter((g) => g.scope === "everyone"), audience))).toEqual(["everyone"]);
  });

  it("never reaches another thread's or another person's grants", () => {
    const others = grants.filter((g) => g.connectionId === "theirs" || g.connectionId === "other-thread");
    expect(narrowestGrantedConnections(others, audience)).toEqual([]);
  });

  it("finds a named connection in whichever audience has it", () => {
    expect(ids(narrowestGrantedConnections(grants, audience, "team"))).toEqual(["everyone"]);
    expect(ids(narrowestGrantedConnections(grants, audience, "personal"))).toEqual(["mine"]);
  });

  it("returns every match in the tier, so selection can ask for an alias", () => {
    const two = [grant("a", "a", "everyone"), grant("b", "b", "everyone")];
    expect(ids(narrowestGrantedConnections(two, audience))).toEqual(["a", "b"]);
  });

  it("without a live session reaches only grants for everyone", () => {
    expect(ids(narrowestGrantedConnections(grants, null))).toEqual(["everyone"]);
  });

  it("lists what each service and label resolves to, and nothing out of reach", () => {
    const all = [...grants, grant("gh", "team", "everyone", "", "github"), grant("shadowed", "thread", "everyone")];
    expect(ids(reachableGrantedConnections(all, audience)).sort()).toEqual(["everyone", "gh", "mine", "thread"]);
    expect(ids(reachableGrantedConnections(all, null)).sort()).toEqual(["everyone", "gh", "shadowed"]);
  });
});
