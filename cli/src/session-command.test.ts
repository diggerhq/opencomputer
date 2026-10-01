import assert from "node:assert/strict";
import test from "node:test";

import {
  developmentAgentReference,
  parseMemoryBinding,
  parseSessionCommand,
  parseSessionListOptions,
  resolveProjectAgent,
} from "./session-command.js";

test("sessions target the bound agent's Development deployment", () => {
  assert.equal(
    developmentAgentReference("unleash-mcp-test"),
    "unleash-mcp-test@development",
  );
});

test("session shorthand targets the normal create flow", () => {
  assert.deepEqual(parseSessionCommand(["Review", "this", "repository"]), {
    action: "create",
    args: ["Review", "this", "repository"],
    keep: false,
  });
});

test("session create retains lifecycle options", () => {
  assert.deepEqual(parseSessionCommand(["create", "Hello", "--keep"]), {
    action: "create",
    args: ["Hello"],
    keep: true,
  });
});

test("session accepts a project agent selector", () => {
  assert.deepEqual(parseSessionCommand(["Hello", "--agent", "reviewer"]), {
    action: "create",
    args: ["Hello"],
    keep: false,
    agent: "reviewer",
  });
  assert.deepEqual(parseSessionCommand(["--agent=reviewer", "Hello"]), {
    action: "create",
    args: ["Hello"],
    keep: false,
    agent: "reviewer",
  });
});

test("session resolves an agent only within the current project", () => {
  const agents = [
    { id: "triage", name: "Triage" },
    { id: "reviewer", name: "Reviewer" },
  ];
  assert.equal(resolveProjectAgent(agents, "reviewer"), "reviewer");
  assert.equal(resolveProjectAgent(agents, "Triage"), "triage");
  assert.throws(
    () => resolveProjectAgent(agents, "external"),
    /Available agents: triage, reviewer/,
  );
  assert.throws(
    () => resolveProjectAgent(agents, "reviewer@production"),
    /environment aliases are not supported/,
  );
});

for (const option of ["--local", "--remote", "--alias"]) {
  test(`session rejects deprecated routing option ${option}`, () => {
    assert.throws(
      () => parseSessionCommand(["Hello", option, "value"]),
      new RegExp(
        `${option} is no longer supported; sessions use the current project's Development deployment`,
      ),
    );
  });
}

test("session rejects equals-form deprecated routing options", () => {
  assert.throws(
    () => parseSessionCommand(["Hello", "--alias=production"]),
    /--alias is no longer supported/,
  );
});

test("session create binds memory documents and collections", () => {
  assert.deepEqual(
    parseSessionCommand([
      "create",
      "--memory",
      "topics=workshop",
      "--memory=profile=owner:read",
      "--memory",
      "archive",
      "--create-document",
      "Plan the workshop",
    ]),
    {
      action: "create",
      args: ["Plan the workshop"],
      keep: false,
      memory: {
        topics: { scope: "document", id: "workshop", access: "read-write" },
        profile: { scope: "document", id: "owner", access: "read" },
        archive: { scope: "collection" },
      },
      createDocuments: true,
    },
  );
  assert.deepEqual(parseMemoryBinding("notes=work_shop-1:read-write"), {
    resource: "notes",
    binding: { scope: "document", id: "work_shop-1", access: "read-write" },
  });
});

test("session create rejects malformed memory bindings", () => {
  assert.throws(() => parseSessionCommand(["--memory"]), /--memory requires a value/);
  assert.throws(() => parseSessionCommand(["--memory", "Notes=workshop"]), /is not a resource id/);
  assert.throws(() => parseSessionCommand(["--memory", "notes=work shop"]), /is not a document id/);
  assert.throws(() => parseSessionCommand(["--memory", "notes=workshop:write"]), /access must be read or read-write/);
  assert.throws(() => parseSessionCommand(["--memory", "notes=a", "--memory", "notes=b"]), /names resource notes twice/);
  assert.throws(() => parseSessionCommand(["send", "ses-1", "hi", "--memory", "notes=a"]), /only supported when creating/);
  assert.throws(() => parseSessionCommand(["--create-document"]), /needs at least one --memory/);
  assert.throws(() => parseSessionCommand(["--memory", "notes", "--create-document"]), /applies to document bindings/);
});

test("session list accepts an agent id filter", () => {
  assert.deepEqual(parseSessionCommand(["list", "--agent", "reviewer"]), {
    action: "list",
    args: [],
    keep: false,
    agent: "reviewer",
  });
  assert.throws(
    () => parseSessionCommand(["inspect", "ses_1", "--agent", "reviewer"]),
    /only supported when creating or listing/,
  );
});

test("session list takes exact filters, a page size and a cursor", () => {
  const args = [
    "--status",
    "suspended",
    "--external-reference=order-42",
    "--limit",
    "2",
    "--cursor",
    "eyJjIjoxfQ",
  ];
  assert.deepEqual(parseSessionListOptions(args), {
    status: "suspended",
    externalReference: "order-42",
    cursor: "eyJjIjoxfQ",
    limit: 2,
  });
  assert.deepEqual(args, []);
  assert.deepEqual(parseSessionListOptions([]), {});
});

test("session list rejects a page size outside 1..100 and empty filters", () => {
  for (const limit of ["0", "101", "2.5", "-1", "many"]) {
    assert.throws(
      () => parseSessionListOptions(["--limit", limit]),
      /--limit must be a whole number from 1 to 100/,
    );
  }
  assert.throws(() => parseSessionListOptions(["--status"]), /--status requires a value/);
  assert.throws(
    () => parseSessionListOptions(["--external-reference="]),
    /--external-reference requires a value/,
  );
  assert.throws(() => parseSessionListOptions(["--cursor", "--limit", "2"]), /--cursor requires a value/);
});
