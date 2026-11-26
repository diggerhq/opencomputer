// The frames of the socket (spec section 38); no runtime code here.

import type { FeedFrame } from "./http-bodies.js";
import type { ApiEvent } from "./session-objects.js";

/** `feed`, `events:<session id>` or `deltas:<session id>`. */
export type StreamName = string;

export type ClientFrame =
  | { t: "hello"; protocol: 1 }
  | { t: "sub"; stream: StreamName; after?: string; kinds?: string[] }
  | { t: "unsub"; stream: StreamName }
  | { t: "block"; session: string; blockId: string }
  | { t: "auth"; token: string }
  | { t: "ping" };

/** `computer/src/protocol-api.ts`'s `JournalDelta` plus `offset` (section 38.4). */
export interface Delta {
  session: string;
  /** `message.delta` | `reasoning.delta`; open. */
  type: string;
  turnId: string;
  /** `{ blockId, text }` for the text deltas. */
  data: { blockId?: string; text?: string; [field: string]: unknown };
  /** The length of the block's text before this delta. */
  offset: number;
  /** This delta holds the block so far; replace the copy held. */
  whole?: boolean;
}

export type ServerFrame =
  | { t: "ready"; connectionId: string; protocol: 1; org: string; subject: string; expiresAt: string; limits: Record<string, number> }
  | { t: "subd"; stream: StreamName; head: string | null }
  | ({ t: "feed" } & Pick<FeedFrame, "from" | "to" | "rows" | "gone" | "version">)
  | { t: "events"; session: string; from: string; to: string; events: ApiEvent[] }
  | ({ t: "delta" } & Delta)
  | { t: "behind"; stream: StreamName; head: string }
  | { t: "reset"; stream: StreamName; cursor: string | null; seq?: number }
  | { t: "detached"; stream: StreamName; reason: "forbidden" | "gone" | (string & {}) }
  | { t: "error"; code: string; message: string }
  | { t: "pong" };
