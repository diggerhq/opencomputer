import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("delegates the requested directory to opencomputer init", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "create-opencomputer-start-"));
  const capture = resolve(root, "args.json");
  const cli = resolve(root, "cli.mjs");
  try {
    await writeFile(
      cli,
      `import { writeFileSync } from "node:fs";
writeFileSync(process.env.CAPTURE_PATH, JSON.stringify(process.argv.slice(2)));
`,
    );
    const result = spawnSync(process.execPath, [resolve("index.js"), "my-agent"], {
      cwd: resolve(import.meta.dirname, ".."),
      env: {
        ...process.env,
        CAPTURE_PATH: capture,
        OPENCOMPUTER_CREATE_START_CLI_PATH: cli,
      },
    });
    assert.equal(result.status, 0, result.stderr.toString());
    assert.deepEqual(JSON.parse(await readFile(capture, "utf8")), [
      "init",
      "my-agent",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("defaults to the current directory", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "create-opencomputer-start-"));
  const capture = resolve(root, "args.json");
  const cli = resolve(root, "cli.mjs");
  try {
    await writeFile(
      cli,
      `import { writeFileSync } from "node:fs";
writeFileSync(process.env.CAPTURE_PATH, JSON.stringify(process.argv.slice(2)));
`,
    );
    const result = spawnSync(process.execPath, [resolve("index.js")], {
      cwd: resolve(import.meta.dirname, ".."),
      env: {
        ...process.env,
        CAPTURE_PATH: capture,
        OPENCOMPUTER_CREATE_START_CLI_PATH: cli,
      },
    });
    assert.equal(result.status, 0, result.stderr.toString());
    assert.deepEqual(JSON.parse(await readFile(capture, "utf8")), ["init", "."]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("creates the published CLI hello-world application", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "create-opencomputer-start-"));
  const app = resolve(root, "hello-agent");
  try {
    const result = spawnSync(process.execPath, [resolve("index.js"), app], {
      cwd: resolve(import.meta.dirname, ".."),
    });
    assert.equal(result.status, 0, result.stderr.toString());
    assert.equal(
      (
        await stat(
          resolve(app, "opencomputer", "agents", "hello-world", "agent.ts"),
        )
      ).isFile(),
      true,
    );
    assert.equal((await stat(resolve(app, "src", "App.tsx"))).isFile(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
