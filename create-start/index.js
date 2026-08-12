#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

function usage() {
  process.stdout.write(`Create a hello-world OpenComputer application.

Usage:
  npm create @opencomputer/start@latest [directory|.] [--spa|--agent-only]
`);
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}
const spaFlag = args.indexOf("--spa");
const agentOnlyFlag = args.indexOf("--agent-only");
if (spaFlag >= 0) args.splice(spaFlag, 1);
if (agentOnlyFlag >= 0) args.splice(agentOnlyFlag, 1);
if (spaFlag >= 0 && agentOnlyFlag >= 0) {
  process.stderr.write("create-start: choose either --spa or --agent-only\n");
  process.exit(1);
}
if (args.length > 1 || args[0]?.startsWith("-")) {
  usage();
  process.exit(1);
}

const directory = args[0] ?? ".";
let includeSpa = spaFlag >= 0;
if (spaFlag < 0 && agentOnlyFlag < 0) {
  if (process.stdin.isTTY) {
    const prompt = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      process.stdout.write(
        "\nWhat would you like to create?\n\n" +
          "  1) Agent only\n" +
          "  2) Agent + React SPA\n\n",
      );
      const answer = await prompt.question("Select [1]: ");
      includeSpa = ["2", "y", "yes", "spa"].includes(
        answer.trim().toLowerCase(),
      );
    } finally {
      prompt.close();
    }
  } else {
    includeSpa = false;
  }
}
const cliPath = process.env.OPENCOMPUTER_CREATE_START_CLI_PATH
  ? process.env.OPENCOMPUTER_CREATE_START_CLI_PATH
  : fileURLToPath(import.meta.resolve("@opencomputer/cli/dist/index.js"));
const result = spawnSync(
  process.execPath,
  [cliPath, "init", directory, includeSpa ? "--spa" : "--agent-only"],
  {
    stdio: "inherit",
  },
);

if (result.error) {
  process.stderr.write(`create-start: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
