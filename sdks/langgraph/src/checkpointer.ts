// A LangGraph BaseCheckpointSaver backed by Cloudflare Durable Object storage —
// the durable memory for a langgraph agent's session. Modeled on the built-in
// MemorySaver's layout ([threadId, checkpoint_ns, checkpoint_id] keys, writes
// indexed by `${taskId},${idx}`, values run through `serde`) but persisted to the
// DO's async KV so runs survive isolate eviction / hibernation. Postgres/Redis
// savers can't run on Workers (long-lived TCP); this is the Workers-native one.

import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type ChannelVersions,
  type PendingWrite,
  type SerializerProtocol,
} from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";

/** Minimal async KV surface — Cloudflare Durable Object `state.storage` implements it. */
export interface DOStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T = unknown>(options?: { prefix?: string; reverse?: boolean; limit?: number }): Promise<Map<string, T>>;
}

type SerdeVal = { t: string; d: unknown };
type StoredCheckpoint = { checkpoint: SerdeVal; metadata: SerdeVal; parent?: string };
type StoredWrites = Record<string, [taskId: string, channel: string, value: SerdeVal]>;

const ns = (v?: string | null) => v ?? "";

export class DurableObjectSaver extends BaseCheckpointSaver {
  constructor(private storage: DOStorage, serde?: SerializerProtocol) {
    super(serde);
  }

  private ckptKey(t: string, n: string, id: string) { return `ckpt:${t}:${n}:${id}`; }
  private latestKey(t: string, n: string) { return `latest:${t}:${n}`; }
  private writesKey(t: string, n: string, id: string) { return `writes:${t}:${n}:${id}`; }

  private async dump(x: unknown): Promise<SerdeVal> { const [t, d] = await this.serde.dumpsTyped(x); return { t, d }; }
  private async load<T = unknown>(v: SerdeVal): Promise<T> {
    return (await this.serde.loadsTyped(v.t, v.d as Uint8Array)) as T;
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const t = config.configurable?.thread_id as string | undefined;
    if (t === undefined) return undefined;
    const n = ns(config.configurable?.checkpoint_ns);
    let id = config.configurable?.checkpoint_id as string | undefined;
    if (!id) id = await this.storage.get<string>(this.latestKey(t, n));
    if (!id) return undefined;
    const saved = await this.storage.get<StoredCheckpoint>(this.ckptKey(t, n, id));
    if (!saved) return undefined;
    const writesMap = (await this.storage.get<StoredWrites>(this.writesKey(t, n, id))) ?? {};
    const pendingWrites: [string, string, unknown][] = [];
    for (const [taskId, channel, value] of Object.values(writesMap)) {
      pendingWrites.push([taskId, channel, await this.load(value)]);
    }
    const tuple: CheckpointTuple = {
      config: { configurable: { thread_id: t, checkpoint_ns: n, checkpoint_id: id } },
      checkpoint: await this.load<Checkpoint>(saved.checkpoint),
      metadata: await this.load<CheckpointMetadata>(saved.metadata),
      pendingWrites,
    };
    if (saved.parent) {
      tuple.parentConfig = { configurable: { thread_id: t, checkpoint_ns: n, checkpoint_id: saved.parent } };
    }
    return tuple;
  }

  async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    const t = config.configurable?.thread_id as string | undefined;
    if (t === undefined) return;
    const n = ns(config.configurable?.checkpoint_ns);
    const prefix = `ckpt:${t}:${n}:`;
    const map = await this.storage.list<StoredCheckpoint>({ prefix, reverse: true, limit: options?.limit });
    let yielded = 0;
    for (const key of map.keys()) {
      const id = key.slice(prefix.length);
      const tuple = await this.getTuple({ configurable: { thread_id: t, checkpoint_ns: n, checkpoint_id: id } });
      if (tuple) { yield tuple; yielded++; }
      if (options?.limit && yielded >= options.limit) return;
    }
  }

  async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata, _newVersions: ChannelVersions): Promise<RunnableConfig> {
    const t = config.configurable?.thread_id as string;
    const n = ns(config.configurable?.checkpoint_ns);
    const id = checkpoint.id;
    const parent = config.configurable?.checkpoint_id as string | undefined;
    const stored: StoredCheckpoint = { checkpoint: await this.dump(checkpoint), metadata: await this.dump(metadata), parent };
    await this.storage.put(this.ckptKey(t, n, id), stored);
    await this.storage.put(this.latestKey(t, n), id);
    return { configurable: { thread_id: t, checkpoint_ns: n, checkpoint_id: id } };
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const t = config.configurable?.thread_id as string;
    const n = ns(config.configurable?.checkpoint_ns);
    const id = config.configurable?.checkpoint_id as string;
    const key = this.writesKey(t, n, id);
    const existing = (await this.storage.get<StoredWrites>(key)) ?? {};
    for (let idx = 0; idx < writes.length; idx++) {
      const [channel, value] = writes[idx];
      existing[`${taskId},${idx}`] = [taskId, channel, await this.dump(value)];
    }
    await this.storage.put(key, existing);
  }

  async deleteThread(threadId: string): Promise<void> {
    for (const prefix of [`ckpt:${threadId}:`, `writes:${threadId}:`, `latest:${threadId}:`]) {
      const map = await this.storage.list({ prefix });
      for (const key of map.keys()) await this.storage.delete(key);
    }
  }
}
