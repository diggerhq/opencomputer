#!/usr/bin/env bun

import { runCommand, type GlobalOptions } from "./commands.js";

const VERSION = "0.3.6";

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

OpenComputer — build, test, connect, and deploy agents as code

Usage:
  opencomputer login [--no-browser] [--force]
  opencomputer logout [--local]
  opencomputer whoami
  opencomputer templates
  opencomputer agents
  opencomputer init <template> [directory]
  opencomputer dev
  opencomputer session [prompt]
  opencomputer session create <prompt> [--local]
  opencomputer session create [prompt] --remote [--agent <agent>@<alias>] [--keep]
  opencomputer session list
  opencomputer session inspect <session-id>
  opencomputer session attach <session-id>
  opencomputer session send <session-id> <prompt> [--keep]
  opencomputer session end <session-id>
  opencomputer tools add gmail
  opencomputer connect google
  opencomputer connections connect gmail
  opencomputer connections list
  opencomputer connections disconnect gmail|<connection-id>
  opencomputer channels add slack
  opencomputer channels connect slack [--local|--remote]
  opencomputer channels list [--local|--remote]
  opencomputer channels disconnect slack [connection-id] [--local|--remote]
  opencomputer deploy [--alias <alias>]
  opencomputer run <agent> <prompt> [--keep]

Global options:
  --api-url <url>   OpenComputer API (default: https://app.opencomputer.dev)
  --api-key <key>   API key (or OPENCOMPUTER_API_KEY)
  --json            Print machine-readable output
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
  };
  const command = args.shift();
  if (!command) {
    help();
    return;
  }
  await runCommand(command, args, globals);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `opencomputer: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
