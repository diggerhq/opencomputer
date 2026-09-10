import assert from "node:assert/strict";
import test from "node:test";
import {
  bearer,
  defineConnection,
  defineMemory,
  documentMemory,
  httpMemory,
  useMemory,
  useSecret,
  type MemoryProjection,
} from "./index.js";

const HOOKS = Symbol.for("opencomputer.agent-hooks");

/**
 * Mirrors the host's render worker: a per-render scope with the projections
 * the host resolved, keyed by resource id, and the ids the render selected.
 */
function renderWith<T>(
  memory: Record<string, MemoryProjection>,
  render: () => T,
): { result: T; selectedMemory: string[] } {
  const scope = { memory, selectedMemory: new Set<string>() };
  const globals = globalThis as Record<PropertyKey, unknown>;
  globals[HOOKS] = {
    useMemory(id: string) {
      const projection = scope.memory[id];
      if (projection) scope.selectedMemory.add(id);
      return projection;
    },
  };
  try {
    return { result: render(), selectedMemory: [...scope.selectedMemory].sort() };
  } finally {
    delete globals[HOOKS];
  }
}

test("defineMemory returns a frozen document declaration by default", () => {
  const memory = defineMemory({
    id: "requirements",
    description: "  Verified requirements for a workshop.  ",
  });
  assert.deepEqual(memory, {
    kind: "memory",
    version: 1,
    id: "requirements",
    description: "Verified requirements for a workshop.",
    provider: { kind: "document", maxBytes: 8192 },
  });
  assert.ok(Object.isFrozen(memory));
  assert.ok(Object.isFrozen(memory.provider));
  assert.equal(JSON.parse(JSON.stringify(memory)).provider.maxBytes, 8192);
});

test("documentMemory validates maxBytes at definition time", () => {
  assert.deepEqual(documentMemory({ maxBytes: 16_384 }), {
    kind: "document",
    maxBytes: 16_384,
  });
  for (const maxBytes of [0, -1, 1.5, 16_385, Number.NaN]) {
    assert.throws(
      () => documentMemory({ maxBytes }),
      /maxBytes must be a whole number between 1 and 16384/,
    );
  }
});

test("defineMemory applies the framework identifier rules", () => {
  for (const id of ["", " ", "Requirements", "notes_v2", "-notes", "a--b"]) {
    assert.throws(() => defineMemory({ id, description: "x" }));
  }
  assert.throws(
    () => defineMemory({ id: "a".repeat(129), description: "x" }),
    /at most 128 characters/,
  );
  assert.throws(
    () => defineMemory({ id: "notes", description: "   " }),
    /requires a non-empty description/,
  );
});

const connection = defineConnection({
  id: "memory-service",
  origin: "https://memory.example.com",
  methods: ["POST"],
  pathPrefix: "/oc-memory",
  headers: { Authorization: bearer(useSecret("MEMORY_TOKEN")) },
});

test("httpMemory serializes the connection id, path, limit, and tools", () => {
  const provider = httpMemory({
    connection,
    path: "/oc-memory",
    tools: [
      {
        name: "remember",
        description: "Save a verified fact for future work.",
        access: "write",
        input: {
          type: "object",
          properties: { fact: { type: "string", maxLength: 2_000 } },
          required: ["fact"],
          additionalProperties: false,
        },
      },
    ],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(provider)), {
    kind: "http",
    connection: "memory-service",
    path: "/oc-memory",
    maxBytes: 8192,
    tools: [
      {
        name: "remember",
        description: "Save a verified fact for future work.",
        access: "write",
        idempotent: false,
        input: {
          type: "object",
          properties: { fact: { type: "string", maxLength: 2_000 } },
          required: ["fact"],
          additionalProperties: false,
        },
      },
    ],
  });
  assert.ok(Object.isFrozen(provider.tools));
  assert.ok(Object.isFrozen(provider.tools[0]));
});

test("httpMemory defaults the path and tools and keeps them inside the connection", () => {
  const open = defineConnection({
    id: "open-memory",
    origin: "https://memory.example.com",
  });
  assert.deepEqual(httpMemory({ connection: open }), {
    kind: "http",
    connection: "open-memory",
    path: "/memory",
    maxBytes: 8192,
    tools: [],
  });
  assert.throws(
    () => httpMemory({ connection }),
    /outside connection memory-service pathPrefix \/oc-memory/,
  );
  const readOnly = defineConnection({
    id: "read-only",
    origin: "https://memory.example.com",
    methods: ["GET"],
  });
  assert.throws(
    () => httpMemory({ connection: readOnly }),
    /requires connection read-only to allow POST/,
  );
  for (const path of ["memory", "//memory", "/memory?x=1", "/memory#top", "/a b"]) {
    assert.throws(
      () => httpMemory({ connection: open, path }),
      /must begin with a single \/ and contain no query or fragment/,
    );
  }
  assert.throws(
    () => httpMemory({ connection: open, maxBytes: 20_000 }),
    /maxBytes must be a whole number between 1 and 16384/,
  );
  assert.throws(
    () => httpMemory({ connection: undefined as never }),
    /requires a defineConnection\(\) connection/,
  );
});

test("httpMemory validates tool declarations", () => {
  const open = defineConnection({
    id: "open-memory",
    origin: "https://memory.example.com",
  });
  const tool: Record<string, unknown> = {
    name: "remember",
    description: "Save a fact.",
    access: "write",
    input: { type: "object", properties: {} },
  };
  const declare = (tools: Array<Record<string, unknown>>) =>
    httpMemory({ connection: open, tools: tools as never });
  for (const name of ["", "Remember", "re-member", "a".repeat(33)]) {
    assert.throws(
      () => declare([{ ...tool, name }]),
      /tool names must use 1 to 32 lowercase letters, numbers, and underscores/,
    );
  }
  assert.throws(() => declare([tool, tool]), /remember is declared more than once/);
  assert.throws(
    () => declare(Array.from({ length: 9 }, (_, i) => ({ ...tool, name: `t${i}` }))),
    /at most 8 tools/,
  );
  assert.throws(() => declare([{ ...tool, description: " " }]), /requires a description/);
  assert.throws(
    () => declare([{ ...tool, access: "admin" }]),
    /access must be "read" or "write"/,
  );
  assert.throws(
    () => declare([{ ...tool, idempotent: "yes" }]),
    /idempotent must be true or false/,
  );
  assert.equal(declare([{ ...tool, idempotent: true }]).tools[0]!.idempotent, true);
  assert.throws(
    () => declare([{ ...tool, input: { type: "string" } }]),
    /input must be a JSON Schema with type "object"/,
  );
  assert.throws(() => declare([{ ...tool, input: undefined }]), /input must be a JSON Schema object/);
  assert.throws(
    () => declare([{ ...tool, input: { type: "object", properties: { a: { $ref: "#/x" } } } }]),
    /input cannot use \$ref/,
  );
});

test("httpMemory rejects the reserved memory argument in tool input", () => {
  const open = defineConnection({
    id: "open-memory",
    origin: "https://memory.example.com",
  });
  const reserved = /cannot declare the reserved memory argument/;
  assert.throws(
    () =>
      httpMemory({
        connection: open,
        tools: [
          {
            name: "search",
            description: "Search.",
            access: "read",
            input: {
              type: "object",
              properties: { memory: { type: "string" }, query: { type: "string" } },
            },
          },
        ],
      }),
    reserved,
  );
  assert.throws(
    () =>
      httpMemory({
        connection: open,
        tools: [
          {
            name: "search",
            description: "Search.",
            access: "read",
            input: { type: "object", required: ["memory"] },
          },
        ],
      }),
    reserved,
  );
});

test("defineMemory rejects providers that are not descriptors", () => {
  assert.throws(
    () =>
      defineMemory({
        id: "notes",
        description: "Notes.",
        provider: { kind: "redis" } as never,
      }),
    /provider must be documentMemory\(\) or httpMemory\(\)/,
  );
});

test("defineMemory normalizes a hand-written descriptor like the provider functions do", () => {
  assert.deepEqual(
    defineMemory({
      id: "notes",
      description: "Notes.",
      provider: { kind: "document", maxBytes: 4_096 },
    }).provider,
    documentMemory({ maxBytes: 4_096 }),
  );
  assert.throws(
    () =>
      defineMemory({
        id: "notes",
        description: "Notes.",
        provider: { kind: "document", maxBytes: 16_385 },
      }),
    /Memory notes maxBytes must be a whole number between 1 and 16384/,
  );
  assert.throws(
    () =>
      defineMemory({
        id: "notes",
        description: "Notes.",
        provider: { kind: "http", connection: "", path: "/memory", maxBytes: 1, tools: [] },
      }),
    /Memory notes requires a defineConnection\(\) connection/,
  );
  assert.throws(
    () =>
      defineMemory({
        id: "notes",
        description: "Notes.",
        provider: {
          kind: "http",
          connection: "memory-service",
          path: "/memory",
          maxBytes: 1,
          tools: [{ name: "x", description: "X.", access: "read", idempotent: false, input: { type: "object", required: ["memory"] } }],
        },
      }),
    /Memory notes tool x input cannot declare the reserved memory argument/,
  );
});

test("httpMemory freezes tool descriptors deeply and copies the caller's schema", () => {
  const open = defineConnection({
    id: "open-memory",
    origin: "https://memory.example.com",
  });
  const input = {
    type: "object",
    properties: { fact: { type: "string", maxLength: 2_000 } },
    required: ["fact"],
  };
  const provider = httpMemory({
    connection: open,
    tools: [{ name: "remember", description: "Save.", access: "write", input }],
  });
  const tool = provider.tools[0]!;
  assert.ok(Object.isFrozen(provider));
  assert.ok(Object.isFrozen(provider.tools));
  assert.ok(Object.isFrozen(tool));
  assert.ok(Object.isFrozen(tool.input));
  assert.ok(Object.isFrozen(tool.input.properties));
  assert.ok(Object.isFrozen(tool.input.required));
  assert.ok(
    Object.isFrozen((tool.input.properties as Record<string, unknown>).fact),
  );
  assert.notEqual(tool.input, input);
  input.properties.fact.maxLength = 1;
  assert.equal(
    (tool.input.properties as Record<string, { maxLength: number }>).fact!.maxLength,
    2_000,
  );
});

test("a projection carries no provider read state", () => {
  // Cursors stay with the host: the type is the promise, checked at build.
  const keys: Array<keyof MemoryProjection> = ["text", "sources", "writable"];
  // @ts-expect-error a cursor is not a hook value.
  const cursor: keyof MemoryProjection = "cursor";
  assert.deepEqual([...keys, cursor].length, 4);
});

test("useMemory reads the host projection and records the selection", () => {
  const requirements = defineMemory({
    id: "requirements",
    description: "Requirements.",
  });
  const projection: MemoryProjection = {
    text: "Node.js 22, no paid services.",
    sources: [
      {
        id: "workshop",
        title: "Workshop requirements",
        revision: "r2",
        updatedAt: "2026-09-10T12:00:00.000Z",
      },
    ],
    writable: true,
  };
  const { result, selectedMemory } = renderWith(
    { requirements: projection, budget: { text: "", sources: [], writable: false } },
    () => useMemory(requirements),
  );
  assert.equal(result, projection);
  assert.deepEqual(selectedMemory, ["requirements"]);
  assert.deepEqual(
    renderWith({ requirements: projection }, () => useMemory("requirements")).result,
    projection,
  );
});

test("useMemory fails a render whose session has no binding for the resource", () => {
  assert.throws(
    () => renderWith({}, () => useMemory("requirements")),
    /Memory "requirements" is not bound to this session/,
  );
  assert.throws(
    () =>
      renderWith(
        { requirements: { text: "x" } as never },
        () => useMemory("requirements"),
      ),
    /Memory "requirements" is not bound to this session/,
  );
  assert.throws(() => renderWith({}, () => useMemory("Not Valid")));
  assert.throws(
    () => useMemory("requirements"),
    /hooks can only run while rendering an agent/,
  );
});
