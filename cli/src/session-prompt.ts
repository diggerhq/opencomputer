import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export interface SessionPromptEvent {
  type: string;
  data: Record<string, unknown>;
}

interface SessionPromptOptions {
  agentName: string;
  verbose?: boolean;
  input?: Readable;
  output?: Writable;
  send(
    prompt: string,
    sessionId: string | undefined,
    emit: (event: SessionPromptEvent) => void,
  ): Promise<string>;
}

export function formatSessionEvent(
  event: SessionPromptEvent,
): string | undefined {
  if (event.type === "message.delta" || event.type === "message.completed") {
    return undefined;
  }
  return `Event: ${event.type} ${JSON.stringify(event.data)}`;
}

const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function startSpinner(output: Writable, enabled: boolean): () => void {
  if (!enabled) return () => undefined;
  let frame = 0;
  let stopped = false;
  output.write(spinnerFrames[frame]);
  const timer = setInterval(() => {
    frame = (frame + 1) % spinnerFrames.length;
    output.write(`\b${spinnerFrames[frame]}`);
  }, 80);
  timer.unref();

  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    output.write("\b \b");
  };
}

export async function runSessionPrompt(
  options: SessionPromptOptions,
): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const terminal = "isTTY" in input && input.isTTY === true;
  const lines = createInterface({ input, output, terminal, crlfDelay: Infinity });
  lines.on("SIGINT", () => lines.close());

  output.write(
    `OpenComputer session — ${options.agentName}\n` +
      "Type /exit or /quit to leave.\n\n" +
      "User: ",
  );

  let sessionId: string | undefined;
  try {
    for await (const line of lines) {
      if (!terminal) output.write(`${line}\n`);
      const prompt = line.trim();
      if (prompt === "/exit" || prompt === "/quit") break;
      if (!prompt) {
        output.write("User: ");
        continue;
      }

      output.write("Agent: ");
      const stopSpinner = startSpinner(
        output,
        "isTTY" in output && output.isTTY === true,
      );
      let streamedText = false;
      let printedEvents = false;
      try {
        sessionId = await options.send(prompt, sessionId, (event) => {
          if (event.type === "message.delta") {
            stopSpinner();
            if (printedEvents && !streamedText) output.write("Agent: ");
            streamedText = true;
            output.write(String(event.data.text ?? ""));
          } else if (event.type === "message.completed" && !streamedText) {
            stopSpinner();
            if (printedEvents) output.write("Agent: ");
            output.write(String(event.data.text ?? ""));
          } else if (options.verbose) {
            const formatted = formatSessionEvent(event);
            if (!formatted) return;
            stopSpinner();
            if (!printedEvents) output.write("\n");
            printedEvents = true;
            output.write(`${formatted}\n`);
          }
        });
      } catch (error: unknown) {
        stopSpinner();
        output.write(
          `Error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      stopSpinner();
      output.write("\n\nUser: ");
    }
  } finally {
    lines.close();
    output.write("\n");
  }
}
