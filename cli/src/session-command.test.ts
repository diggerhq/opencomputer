import assert from "node:assert/strict";
import test from "node:test";

import {
  developmentAgentReference,
  parseMemoryBinding,
  parseSessionCommand,
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
        `${option} is no longer supported; sessions use the project's current deployment`,
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
