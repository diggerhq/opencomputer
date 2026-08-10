#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function usage() {
  process.stdout.write(`Create a hello-world OpenComputer application.

Usage:
  npm create @opencomputer/start@latest [directory|.]
`);
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}
if (args.length > 1 || args[0]?.startsWith("-")) {
  usage();
  process.exit(1);
}

const directory = args[0] ?? ".";
const cliPath = process.env.OPENCOMPUTER_CREATE_START_CLI_PATH
  ? process.env.OPENCOMPUTER_CREATE_START_CLI_PATH
  : fileURLToPath(import.meta.resolve("@opencomputer/cli/dist/index.js"));
const result = spawnSync(process.execPath, [cliPath, "init", directory], {
  stdio: "inherit",
});

if (result.error) {
  process.stderr.write(`create-start: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
