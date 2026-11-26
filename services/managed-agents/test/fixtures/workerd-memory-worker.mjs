// The workerd-memory test worker: the Workerd session runtime plus the edge
// worker's Memory Durable Object in one script, so the host reaches the real
// object over the MEMORY binding the way production does across scripts.
// Plain JavaScript on purpose: the runtime is type-checked by its own
// tsconfig, not the root one.
export { OpenCodeSessionDurableObject, default } from "../../src/workerd-runtime/index.ts";
export { MemoryDurableObject } from "../../src/edge/memory-do.ts";
