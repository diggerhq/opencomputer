// What the fake's parts share: the clock, the generator, the timers and each other.

import type { Actor, Principal } from "../types.js";
import type { Agents } from "./agent.js";
import type { Live } from "./live.js";
import type { Log } from "./log.js";
import type { Mutations } from "./mutations.js";
import type { Org } from "./org.js";

export interface Ctx {
  principal: Principal;
  /** Milliseconds, with what `age` added. */
  now(): number;
  iso(ms?: number): string;
  /** The seeded generator: ids and chaos draw from it. */
  rand(): number;
  id(prefix: string, n?: number): string;
  /** A timer `idle()` waits for. */
  later(fn: () => void, ms: number): void;
  sleep(ms: number): Promise<void>;
  /** Work `idle()` waits for. */
  job(p: Promise<unknown>): void;
  pace: number;
  auto: boolean;
  org: Org;
  log: Log;
  live: Live;
  mutations: Mutations;
  agents: Agents;
}

export class Refusal extends Error {
  constructor(
    public code: string,
    public reason: string,
    public detail: Record<string, unknown> = {},
  ) {
    super(`${code}: ${reason}`);
  }
}

/** Section 34.2's statuses. */
export const STATUS: Record<string, number> = { not_found: 404, principal_mismatch: 403, invalid_request: 400 };
export const statusOf = (code: string): number => STATUS[code] ?? 409;

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
export function makeFakeId(rand: () => number, prefix: string, n = 16): string {
  let s = "";
  for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(rand() * 32)];
  return `${prefix}_${s}`;
}

export function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/** How rows name a person: the member id (types.ts, `By`). */
export const isPerson = (by: string | null | undefined): boolean => !!by && !by.startsWith("agent:") && !by.startsWith("rule:") && by !== "platform";

export const personActor = (p: Principal): Actor => ({ id: p.subject, name: "Igor", via: "app", client: null });
export const PLATFORM: Actor = { id: "platform", name: null, via: "platform", client: null };
export const agentActor = (sid: string): Actor => ({ id: `agent:${sid}`, name: null, via: "agent", client: null });
