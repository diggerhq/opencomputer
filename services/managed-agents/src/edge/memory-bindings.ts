import {
  MEMORY_LIMITS,
  type MemoryBinding,
  type MemoryDeclaration,
  type MemoryStub,
} from "./memory-contract.js";

/**
 * Session-create `memory` bindings (document-memory.mdx, "Session
 * bindings"): `{ [resource]: { scope, id?, access? } }`, normalized to one
 * `MemoryBinding` per resource and checked against the deployment's
 * declarations before the Session DO admits them. The Memory DO remains the
 * authority at `issueGrants`; the checks here give the caller a 400 before
 * any session exists.
 */

export function parseMemoryBindings(
  value: unknown,
): { bindings: MemoryBinding[] } | { error: string } {
  if (value === undefined) return { bindings: [] };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: "memory must be an object keyed by resource id" };
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MEMORY_LIMITS.bindingsPerSession) {
    return { error: `At most ${String(MEMORY_LIMITS.bindingsPerSession)} memory bindings per session` };
  }
  const bindings: MemoryBinding[] = [];
  for (const [resource, raw] of entries) {
    if (!MEMORY_LIMITS.documentIdPattern.test(resource)) {
      return { error: `Invalid memory resource id ${JSON.stringify(resource)}` };
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { error: `memory.${resource} must be an object with scope, id and access` };
    }
    const binding = raw as Record<string, unknown>;
    const unknown = Object.keys(binding).find((key) => !["scope", "id", "access"].includes(key));
    if (unknown) return { error: `memory.${resource}: unknown field ${unknown}` };
    const access = binding.access ?? "read";
    if (access !== "read" && access !== "read-write") {
      return { error: `memory.${resource}.access must be "read" or "read-write"` };
    }
    if (binding.scope === "document") {
      if (typeof binding.id !== "string" || !MEMORY_LIMITS.documentIdPattern.test(binding.id)) {
        return { error: `memory.${resource}.id must be a document id (1-128 letters, digits, - or _)` };
      }
      bindings.push({ resource, scope: "document", id: binding.id, access });
      continue;
    }
    if (binding.scope === "collection") {
      if (binding.id !== undefined) {
        return { error: `memory.${resource}: a collection binding takes no id` };
      }
      if (access !== "read") {
        return { error: `memory.${resource}: collection-wide writes are not supported` };
      }
      bindings.push({ resource, scope: "collection", access: "read" });
      continue;
    }
    return { error: `memory.${resource}.scope must be "document" or "collection"` };
  }
  bindings.sort((a, b) => (a.resource < b.resource ? -1 : a.resource > b.resource ? 1 : 0));
  return { bindings };
}

export function sameMemoryBindings(a: MemoryBinding[], b: MemoryBinding[]): boolean {
  const normalize = (bindings: MemoryBinding[]) =>
    JSON.stringify(
      [...bindings]
        .map((binding) =>
          binding.scope === "document"
            ? { resource: binding.resource, scope: "document", id: binding.id, access: binding.access }
            : { resource: binding.resource, scope: "collection", access: "read" },
        )
        .sort((x, y) => (x.resource < y.resource ? -1 : x.resource > y.resource ? 1 : 0)),
    );
  return normalize(a) === normalize(b);
}

/**
 * Why the bindings cannot be admitted against this deployment, or null.
 * Declarations gate the resources; the Memory DO's current documents gate
 * document bindings (an early answer; `issueGrants` re-checks atomically).
 */
export async function validateMemoryBindings(
  bindings: MemoryBinding[],
  declarations: MemoryDeclaration[],
  memory: MemoryStub,
): Promise<string | null> {
  const declared = new Map(declarations.map((declaration) => [declaration.id, declaration]));
  for (const binding of bindings) {
    const declaration = declared.get(binding.resource);
    if (!declaration) {
      return `Memory resource ${binding.resource} is not declared by the session's deployment`;
    }
    if (declaration.provider.kind !== "document") {
      return `Memory resource ${binding.resource} uses the ${declaration.provider.kind} provider, which is not available for sessions yet`;
    }
    if (binding.scope === "document") {
      const outcome = await memory.getDocument(binding.resource, binding.id);
      if (outcome.kind !== "document") {
        return `Memory document ${binding.resource}/${binding.id} does not exist${outcome.kind === "deleted" ? " (deleted)" : ""}`;
      }
    }
  }
  return null;
}
