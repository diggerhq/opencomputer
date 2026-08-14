import assert from "node:assert/strict";
import test from "node:test";

import {
  developmentAgentReference,
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
