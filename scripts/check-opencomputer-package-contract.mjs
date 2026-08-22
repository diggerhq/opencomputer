import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const load = async (path) => JSON.parse(await readFile(path, "utf8"));
const cli = await load("cli/package.json");
const starter = await load("create-start/package.json");

assert.equal(
  cli.bin?.cli,
  cli.bin?.opencomputer,
  "@opencomputer/cli must expose a package-name bin so `npx @opencomputer/cli` is unambiguous",
);

assert.equal(
  starter.version,
  cli.version,
  "@opencomputer/create-start and @opencomputer/cli must share a version",
);
assert.equal(
  starter.dependencies?.["@opencomputer/cli"],
  cli.version,
  "@opencomputer/create-start must depend on the exact CLI version",
);

process.stdout.write(`Package contract OK: ${cli.version}\n`);
