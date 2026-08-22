import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { runCreateStart } from "./create-start.js";

test("CLI-owned create-start generates agent-only projects", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "opencomputer-create-start-"));
  const app = resolve(root, "agent-only");
  try {
    await runCreateStart([app]);
    await stat(
      resolve(app, "opencomputer", "agents", "hello-world", "agent.ts"),
    );
    await assert.rejects(stat(resolve(app, "src")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI-owned create-start keeps the legacy SPA opt-in explicit", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "opencomputer-create-start-"));
  const app = resolve(root, "with-spa");
  try {
    await runCreateStart([app, "--spa"]);
    await stat(resolve(app, "src", "App.tsx"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
