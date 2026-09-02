import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { materializeProjectArchive } from "./project-local.js";

const exec = promisify(execFile);

test("project archive materialization creates a new local checkout", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "opencomputer-project-local-test-"));
  try {
    const source = resolve(root, "source");
    const target = resolve(root, "hello-world");
    const archive = resolve(root, "project.tar.gz");
    await mkdir(resolve(source, "opencomputer"), { recursive: true });
    await writeFile(
      resolve(source, "opencomputer", "project.ts"),
      'export default { name: "Hello World" }\n',
    );
    await exec("tar", ["-czf", archive, "-C", source, "."]);

    const result = await materializeProjectArchive({
      response: new Response(await readFile(archive)),
      directory: target,
    });

    assert.equal(result.directory, target);
    assert.equal(
      await readFile(resolve(target, "opencomputer", "project.ts"), "utf8"),
      'export default { name: "Hello World" }\n',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
