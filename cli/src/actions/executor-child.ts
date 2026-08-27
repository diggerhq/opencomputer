import { pathToFileURL } from "node:url";

interface ExecutionEnvelope {
  entry: string;
  definitionId: string;
  actionId: string;
  requestOid: string;
  input: Record<string, unknown>;
  secrets: Record<string, string>;
  repositories: Record<
    string,
    { id: string; remote: string; defaultBranch: string }
  >;
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ExecutionEnvelope;
  const module = (await import(pathToFileURL(envelope.entry).href)) as Record<string, unknown>;
  const definition = Object.values(module).find(
    (value): value is { id: string; kind: "action"; run: (context: unknown) => unknown } =>
      Boolean(
        value &&
          typeof value === "object" &&
          "kind" in value &&
          value.kind === "action" &&
          "id" in value &&
          value.id === envelope.definitionId &&
          "run" in value &&
          typeof value.run === "function",
      ),
  );
  if (!definition) throw new Error(`Action ${envelope.definitionId} was not found`);
  const output = await definition.run({
    actionId: envelope.actionId,
    requestOid: envelope.requestOid,
    input: envelope.input,
    secrets: envelope.secrets,
    repositories: envelope.repositories,
  });
  if (output === undefined) throw new Error("Action executors must return JSON data");
  process.stdout.write(`${JSON.stringify({ ok: true, output })}\n`);
}

main().catch((error: unknown) => {
  process.stdout.write(
    `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`,
  );
  process.exitCode = 1;
});
