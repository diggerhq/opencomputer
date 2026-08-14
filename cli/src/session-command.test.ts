import assert from "node:assert/strict";
import test from "node:test";

import {
  developmentAgentReference,
  parseSessionCommand,
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

for (const option of ["--local", "--remote", "--agent", "--alias"]) {
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
    () => parseSessionCommand(["Hello", "--agent=example@production"]),
    /--agent is no longer supported/,
  );
});
