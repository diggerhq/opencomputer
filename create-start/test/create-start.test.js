import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("forwards arguments to the CLI-owned initializer", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "create-opencomputer-start-"));
  const capture = resolve(root, "args.json");
  const modulePath = resolve(root, "create-start.mjs");
  try {
    await writeFile(
      modulePath,
      `import { writeFileSync } from "node:fs";
export async function runCreateStart(args) {
  writeFileSync(process.env.CAPTURE_PATH, JSON.stringify(args));
}
`,
    );
    const result = spawnSync(
      process.execPath,
      [resolve("index.js"), "my-agent"],
      {
        cwd: resolve(import.meta.dirname, ".."),
        env: {
          ...process.env,
          CAPTURE_PATH: capture,
          OPENCOMPUTER_CREATE_START_MODULE_PATH: modulePath,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr.toString());
    assert.deepEqual(JSON.parse(await readFile(capture, "utf8")), [
      "my-agent",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("creates an app through the local CLI module", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "create-opencomputer-start-"));
  const app = resolve(root, "hello-agent");
  const localModule = resolve(
    import.meta.dirname,
    "..",
    "..",
    "cli",
    "dist",
    "create-start.js",
  );
  try {
    const result = spawnSync(
      process.execPath,
      [resolve("index.js"), app],
      {
        cwd: resolve(import.meta.dirname, ".."),
        env: {
          ...process.env,
          OPENCOMPUTER_CREATE_START_MODULE_PATH: localModule,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr.toString());
    assert.equal(
      (
        await stat(
          resolve(app, "opencomputer", "agents", "hello-world", "agent.ts"),
        )
      ).isFile(),
      true,
    );
    await assert.rejects(stat(resolve(app, "src", "App.tsx")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
