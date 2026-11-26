// Ids made from Slack's own keys, so a retry makes the same one: a thread's session, a message's turn,
// an interaction's entry.

import { CROCKFORD } from "./session-ids.js";

async function crockford(text: string, n: number): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  let out = "";
  for (let i = 0; i < n; i++) out += CROCKFORD[digest[i]! & 31];
  return out;
}

/** A Slack thread's session id, made from its key so a retry makes the same one: `cs_` + 16. */
export const sessionIdFor = async (key: string): Promise<string> => `cs_${await crockford(`slack-thread\0${key}`, 16)}`;

/** A Slack message's turn id: `tn_` + 12 of the hash of its thread key and ts. */
export const turnIdFor = async (key: string, ts: string): Promise<string> => `tn_${await crockford(`${key}\0${ts}`, 12)}`;

/** An interaction's entry id (an answer or a dismiss), from Slack's own id for it. */
export const entryIdFor = async (prefix: string, id: string): Promise<string> => `${prefix}_${await crockford(id, 12)}`;
