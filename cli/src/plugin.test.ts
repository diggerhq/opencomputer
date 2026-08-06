import assert from "node:assert/strict";
import test from "node:test";

import { defineOperation, definePlugin, definePlugins, schema } from "./plugin.js";

test("plugins expose typed scoped operations", () => {
  const inspect = defineOperation({
    description: "Inspect a repository",
    input: schema.object({ repository: schema.string() }),
    output: schema.object({ sha: schema.string() }),
    execution: "broker",
    effects: ["external.read"],
    network: ["https://api.github.com"],
    async execute() {
      return { sha: "abc" };
    },
  });
  const plugin = definePlugin({
    name: "github",
    packageName: "@opencomputer/plugin-github",
    displayName: "GitHub",
    description: "GitHub repository operations",
    operations: { "repository.inspect": inspect },
  });
  assert.deepEqual(definePlugins([plugin]).plugins, [plugin]);
});

test("hybrid operations must declare workspace creation", () => {
  assert.throws(
    () =>
      defineOperation({
        description: "Unsafe checkout",
        input: schema.object({}),
        output: schema.object({}),
        execution: "hybrid",
        effects: ["external.read"],
        async execute() {
          return {};
        },
      }),
    /workspace\.create/,
  );
});

test("plugin sets reject duplicate plugin namespaces", () => {
  const operation = defineOperation({
    description: "Read a value",
    input: schema.object({}),
    output: schema.object({}),
    execution: "broker",
    effects: ["external.read"],
    async execute() {
      return {};
    },
  });
  const plugin = definePlugin({
    name: "example",
    packageName: "@acme/example",
    displayName: "Example",
    description: "Example plugin",
    operations: { read: operation },
  });
  assert.throws(() => definePlugins([plugin, plugin]), /Duplicate plugin name/);
});
