#!/usr/bin/env node

import { readFileSync } from "node:fs";

import { runCommand, type GlobalOptions } from "./commands.js";
import { structuredError } from "./errors.js";

const VERSION = String(
  (
    JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: unknown }
  ).version,
);

const BANNER = String.raw`   ____                   ______                            __
  / __ \____  ___  ____  / ____/___  ____ ___  ____  __  / /____  _____
 / / / / __ \/ _ \/ __ \/ /   / __ \/ __  __ \/ __ \/ / / / __ \/ ___/
/ /_/ / /_/ /  __/ / / / /___/ /_/ / / / / / / /_/ / /_/ / /_/ / /
\____/ .___/\___/_/ /_/\____/\____/_/ /_/ /_/ .___/\__,_/\____/_/
    /_/                                      /_/`;

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  args.splice(index, 2);
  return value;
}

function takeFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function help(): void {
  process.stdout.write(`${BANNER}

OpenComputer — build, test, and deploy agents as code

Usage:
  opencomputer login [--no-browser] [--force]
  opencomputer logout [--local]
  opencomputer whoami
  opencomputer agents
  opencomputer init <directory|.>
  opencomputer link (--project <id|slug> | --create-project <name>)
  opencomputer doctor
  opencomputer deploy --watch [--project <id|slug> | --create-project <name>]
  opencomputer dev [--project <id|slug> | --create-project <name>]  (legacy alias)
  opencomputer session [prompt] [--agent <project-agent>] [--keep]
  opencomputer session create [prompt] [--agent <project-agent>] [--keep]
  opencomputer session list
  opencomputer session inspect <session-id>
  opencomputer session attach <session-id>
  opencomputer session send <session-id> <prompt> [--keep]
  opencomputer session end <session-id>
  opencomputer secrets set <name> --value-stdin [--environment development|production] [--agent <agent>|current]
  opencomputer secrets list [--environment development|production] [--agent <agent>|current]
  opencomputer secrets remove <name> [--environment development|production] [--agent <agent>|current]
  opencomputer env set <name> --value-stdin [--environment development|production] [--agent <agent>|current]
  opencomputer env list [--environment development|production] [--agent <agent>|current]
  opencomputer env remove <name> [--environment development|production] [--agent <agent>|current]
  opencomputer model-access connect codex [--project <id|slug>]
  opencomputer model-access list
  opencomputer model-access disconnect codex
  opencomputer webhooks list [--environment development|production] [--agent <agent>|current]
  opencomputer webhooks create <name> [--environment development|production] [--agent <agent>|current]
  opencomputer webhooks enable <webhook-id> [--project <id|slug>]
  opencomputer webhooks disable <webhook-id> [--project <id|slug>]
  opencomputer webhooks rotate-token <webhook-id> [--project <id|slug>]
  opencomputer webhooks remove <webhook-id> [--project <id|slug>]
  opencomputer logs [--agent <agent>] [--session <session-id>] [--environment development|production] [--follow]
  opencomputer channels status [--agent <agent>] [--environment development|production]
  opencomputer sessions tail <session-id> [--after <cursor>] [--no-follow]
  opencomputer deploy [--alias development|production] [--watch]
  opencomputer run <agent> <prompt> [--keep]

Global options:
  --api-url <url>   OpenComputer API (default: https://app.opencomputer.dev)
  --api-key <key>   API key (or OPENCOMPUTER_API_KEY)
  --json            Print machine-readable output
  --idempotency-key <key>  Stable retry key for mutating commands
  --verbose         Print session events
  --help            Show this help
  --version         Show the CLI version
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (takeFlag(args, "--version")) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (!args.length || takeFlag(args, "--help")) {
    help();
    return;
  }
  const globals: GlobalOptions = {
    apiUrl: takeOption(args, "--api-url"),
    apiKey: takeOption(args, "--api-key"),
    json: takeFlag(args, "--json"),
    verbose: takeFlag(args, "--verbose"),
    idempotencyKey: takeOption(args, "--idempotency-key"),
  };
  const command = args.shift();
  if (!command) {
    help();
    return;
  }
  await runCommand(command, args, globals);
}

main().catch((error: unknown) => {
  const failure = structuredError(error);
  if (process.argv.includes("--json")) {
    process.stderr.write(`${JSON.stringify({ error: failure })}\n`);
  } else {
    process.stderr.write(`opencomputer: ${failure.message}\nfix: ${failure.hint}\n`);
  }
  process.exitCode = 1;
});
