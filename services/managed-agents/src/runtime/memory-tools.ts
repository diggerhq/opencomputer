import type { MemoryBinding } from "../edge/memory-contract.js";

/**
 * The fixed memory tools, shared by the Workerd runtime and the sandbox
 * session runtime so the model sees the same names, schemas and guidance
 * on either. The tools' execution differs by runtime (a Durable Object RPC
 * on Workerd, the edge memory route on the sandbox); what the model reads
 * does not.
 */
export type MemoryToolName = "memory_save" | "memory_read" | "memory_list";

export const memoryToolNames: readonly MemoryToolName[] = [
  "memory_save",
  "memory_read",
  "memory_list",
];

/** Which fixed tool a binding offers; a read-only document binding offers none. */
export function memoryToolsOf(binding: MemoryBinding): MemoryToolName[] {
  if (binding.scope === "collection") return ["memory_read", "memory_list"];
  return binding.access === "read-write" ? ["memory_save"] : [];
}

export const memoryToolSchemas: Record<MemoryToolName, Record<string, unknown>> = {
  memory_save: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "The whole document; it replaces the current text.",
      },
      summary: {
        type: "string",
        description:
          "Optional one-line summary shown in collection overviews (240 bytes). Omit to keep the current summary; send an empty string to clear it.",
      },
      memory: {
        type: "string",
        description: "The memory resource to save to.",
      },
    },
    required: ["text"],
    additionalProperties: false,
  },
  memory_read: {
    type: "object",
    properties: {
      memory: { type: "string", description: "The memory resource to read from." },
      id: { type: "string", description: "The document id from the overview or a list result." },
    },
    required: ["id"],
    additionalProperties: false,
  },
  memory_list: {
    type: "object",
    properties: {
      memory: { type: "string", description: "The memory resource to list." },
      cursor: {
        type: "string",
        description: "The nextCursor of the previous page; omit for the first page.",
      },
    },
    additionalProperties: false,
  },
};

export const memoryToolSummaries: Record<MemoryToolName, string> = {
  memory_save:
    "Save the whole text of a memory document. The result is JSON: saved (with revision and bytes), conflict (with the current text and summary, when the document changed since you read it) or rejected (with a reason). A conflict or rejection is a result to act on, not an error.",
  memory_read:
    "Read one document of a memory collection by id. The result is the document JSON (id, title, text, summary, revision, updatedAt) or rejected with a reason.",
  memory_list:
    "List the documents of a memory collection, newest updates first: ids, titles, summaries and revisions with a nextCursor for the next page. The result is JSON.",
};

/**
 * The description the model sees for a fixed tool in one request: the tool's
 * summary, the selected resources with their declared descriptions, and
 * whether `memory` must be given.
 */
export function memoryToolDescription(
  tool: MemoryToolName,
  targets: ReadonlyArray<{ resource: string; description: string }>,
): string {
  const lines = [memoryToolSummaries[tool], "", "Memory resources:"];
  for (const target of targets) {
    lines.push(`- ${target.resource}: ${target.description}`);
  }
  lines.push("");
  const only = targets[0];
  lines.push(
    targets.length === 1 && only
      ? `The memory argument may be omitted; it defaults to ${JSON.stringify(only.resource)}.`
      : `The memory argument is required: one of ${targets.map((target) => JSON.stringify(target.resource)).join(", ")}.`,
  );
  return lines.join("\n");
}
