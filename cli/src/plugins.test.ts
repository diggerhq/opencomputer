import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadOperationCatalog, writeOperationCatalog } from "./plugins.js";

test("loads registered npm plugins and writes a progressive operation catalog", async () => {
  const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const root = await mkdtemp(resolve(tmpdir(), "opencomputer-plugins-"));
  try {
    await mkdir(resolve(root, "node_modules", "@opencomputer"), { recursive: true });
    await symlink(cliRoot, resolve(root, "node_modules", "@opencomputer", "cli"));
    await cp(
      resolve(cliRoot, "plugins", "github"),
      resolve(root, "node_modules", "@opencomputer", "plugin-github"),
      { recursive: true },
    );
    await writeFile(resolve(root, "package.json"), '{"type":"module"}\n');
    await writeFile(
      resolve(root, "opencomputer.plugins.ts"),
      `import { definePlugins } from "@opencomputer/cli/plugin";
import { githubPlugin } from "@opencomputer/plugin-github";
export default definePlugins([
  githubPlugin({ operations: ["repository.inspect"] }),
]);
`,
    );

    const catalog = await loadOperationCatalog(root);
    assert.equal(catalog.plugins[0]?.name, "github");
    assert.deepEqual(
      catalog.operations.map((operation) => operation.id),
      ["github.repository.inspect"],
    );
    assert.match(catalog.operations[0]?.packageDigest ?? "", /^[a-f0-9]{64}$/);

    const runtime = resolve(root, "runtime");
    await writeOperationCatalog(runtime, catalog);
    const generated = JSON.parse(
      await readFile(
        resolve(runtime, ".opencomputer", "operations", "catalog.json"),
        "utf8",
      ),
    ) as { operations: Array<{ id: string }> };
    assert.equal(generated.operations[0]?.id, "github.repository.inspect");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
