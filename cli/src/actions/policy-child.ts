import { evaluateActionGate, loadActionBundle } from "./policy.js";
import type { ActionRequestRecord } from "./protocol.js";

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
    entry: string;
    request: ActionRequestRecord;
  };
  const bundle = await loadActionBundle(input.entry);
  const disposition = evaluateActionGate(bundle, input.request);
  process.stdout.write(`${JSON.stringify({ ok: true, disposition })}\n`);
}

main().catch((error: unknown) => {
  process.stdout.write(
    `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`,
  );
  process.exitCode = 1;
});

