// Who is asking (spec 34.3), and who may reach a session (spec 36.2). The edge verifies the
// credential and resolves it to a Principal; state and link actors never see a credential.

import type { ApiScope } from "../computer/api-types.js";

export interface Principal {
  org: string;
  /** `usr_…`; `slack:<team>:<user>`; `cs_…` for an agent; `platform`. */
  subject: string;
  kind: "member" | "key" | "agent" | "platform";
  via: "dashboard" | "app" | "opc" | "api" | "slack" | "agent";
  scopes: ApiScope[];
  /** member, key: `['org', 'member:<subject>']`; agent, platform: `[]`. */
  audiences: string[];
  /** agent: the session the key is bound to. */
  session?: string;
  admin: boolean;
  credential: { id: string; expiresAt: number | null };
}

/** A session's access, owned by Org, copied to its SessionLog and its machine. */
export interface Access {
  owner: string;
  /** `org` or `member:<usr_…>`. */
  audience: string;
  writers: "members" | string[];
  /** `by` of agents that may write whatever `writers` says (spec 40.7 step 4): they are also in `writers` when it is a list. */
  agents?: string[];
  /** `by` of agents that may read, beyond the audience. */
  readers: string[];
  machine: string;
  revision: number;
}

/** The `by` of a principal (spec 34.1): `user:<subject>`, `agent:<cs_…>` or `platform`. */
export function byOf(p: Principal): string {
  if (p.kind === "platform") return "platform";
  if (p.kind === "agent") return `agent:${p.session ?? p.subject}`;
  return `user:${p.subject}`;
}

export function platformPrincipal(org: string): Principal {
  return { org, subject: "platform", kind: "platform", via: "agent", scopes: [], audiences: [], admin: false, credential: { id: "platform", expiresAt: null } };
}

/** Whether `p` may read a session with this access (spec 36.2): anyone else gets `not_found`. */
export function mayRead(p: Principal, access: Access, sessionId: string): boolean {
  if (p.kind === "platform") return true;
  if (p.kind === "agent") return p.session === sessionId || access.readers.includes(byOf(p));
  return p.audiences.includes(access.audience);
}
