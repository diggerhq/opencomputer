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
    await runCreateStart([app, "--agent-only"]);
    await stat(
      resolve(app, "opencomputer", "agents", "hello-world", "agent.ts"),
    );
    await assert.rejects(stat(resolve(app, "src")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
