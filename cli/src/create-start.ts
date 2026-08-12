import { createInterface } from "node:readline/promises";

import { runCommand } from "./commands.js";

function usage(): void {
  process.stdout.write(`Create a hello-world OpenComputer application.

Usage:
  npm create @opencomputer/start@latest [directory|.] [--spa|--agent-only]
`);
}

export async function runCreateStart(rawArgs: string[]): Promise<void> {
  const args = [...rawArgs];
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }
  const spaFlag = args.indexOf("--spa");
  const agentOnlyFlag = args.indexOf("--agent-only");
  if (spaFlag >= 0) args.splice(spaFlag, 1);
  if (agentOnlyFlag >= 0) args.splice(agentOnlyFlag, 1);
  if (spaFlag >= 0 && agentOnlyFlag >= 0) {
    throw new Error("Choose either --spa or --agent-only");
  }
  if (args.length > 1 || args[0]?.startsWith("-")) {
    usage();
    throw new Error("Invalid create-start arguments");
  }

  const directory = args[0] ?? ".";
  let includeSpa = spaFlag >= 0;
  if (spaFlag < 0 && agentOnlyFlag < 0 && process.stdin.isTTY) {
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
  }

  await runCommand("init", [directory, includeSpa ? "--spa" : "--agent-only"], {
    json: false,
  });
}
