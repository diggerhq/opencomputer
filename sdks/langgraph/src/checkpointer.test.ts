import { describe, it, expect } from "vitest";
import { StateGraph, MessagesAnnotation, START, END } from "@langchain/langgraph";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { DurableObjectSaver, type DOStorage } from "./checkpointer.js";

// A Map-backed DOStorage — the same async KV surface Cloudflare Durable Object
// storage exposes, so this exercises the saver's real serialization + key logic
// without needing the Workers runtime.
function memStorage(): DOStorage {
  const m = new Map<string, unknown>();
  return {
    async get<T>(k: string) { return m.get(k) as T | undefined; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { return m.delete(k); },
    async list<T>(opts?: { prefix?: string; reverse?: boolean; limit?: number }) {
      let keys = [...m.keys()].filter((k) => !opts?.prefix || k.startsWith(opts.prefix)).sort();
      if (opts?.reverse) keys.reverse();
      if (opts?.limit != null) keys = keys.slice(0, opts.limit);
      const out = new Map<string, T>();
      for (const k of keys) out.set(k, m.get(k) as T);
      return out;
    },
  };
}

const appendNode = new StateGraph(MessagesAnnotation)
  .addNode("append", async (s) => ({ messages: [new AIMessage("turn:" + s.messages.length)] }))
  .addEdge(START, "append")
  .addEdge("append", END);

describe("DurableObjectSaver", () => {
  it("persists a thread and resumes it across a fresh saver instance", async () => {
    const storage = memStorage();
    const cfg = { configurable: { thread_id: "t1" } };

    // Turn 1: input [human] -> node appends one message -> 2 messages.
    const g1 = appendNode.compile({ checkpointer: new DurableObjectSaver(storage) });
    const r1 = await g1.invoke({ messages: [new HumanMessage("hi")] }, cfg);
    expect(r1.messages.length).toBe(2);

    // Turn 2 with a BRAND-NEW saver over the SAME storage — if state came only from
    // memory this would be 2; resuming from durable storage makes it 4
    // (prior 2 + new human + new appended turn).
    const g2 = appendNode.compile({ checkpointer: new DurableObjectSaver(storage) });
    const r2 = await g2.invoke({ messages: [new HumanMessage("again")] }, cfg);
    expect(r2.messages.length).toBe(4);

    // getTuple (no checkpoint_id) returns the latest committed checkpoint.
    const latest = await new DurableObjectSaver(storage).getTuple(cfg);
    expect(latest?.checkpoint.id).toBeTruthy();

    // list walks the thread's checkpoint history (multiple across the two turns).
    const seen: string[] = [];
    for await (const t of new DurableObjectSaver(storage).list(cfg)) seen.push(t.checkpoint.id);
    expect(seen.length).toBeGreaterThan(1);
  });

  it("isolates threads and deletes them", async () => {
    const storage = memStorage();
    const saver = new DurableObjectSaver(storage);
    const g = appendNode.compile({ checkpointer: saver });
    await g.invoke({ messages: [new HumanMessage("a")] }, { configurable: { thread_id: "A" } });
    await g.invoke({ messages: [new HumanMessage("b")] }, { configurable: { thread_id: "B" } });

    expect(await saver.getTuple({ configurable: { thread_id: "A" } })).toBeDefined();
    await saver.deleteThread("A");
    expect(await saver.getTuple({ configurable: { thread_id: "A" } })).toBeUndefined();
    // B is untouched.
    expect(await saver.getTuple({ configurable: { thread_id: "B" } })).toBeDefined();
  });
});
