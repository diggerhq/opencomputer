// The computer API's rollout gate (work 084): which organizations' hosts are spoken to at
// protocol v4. `COMPUTER_API_ORGS` (edge var): empty or unset, nobody; `*`, everybody; otherwise
// a comma-separated list of organization ids.
//
// A gated-off organization is a v3 organization: its welcome says protocol 3 with no `wire` key
// (calvin then mints no RunnerApi, sends no journal frames and starts no relay), the object records
// its host's protocol as at most 3 (no access, epoch, revoked or v4 Slack fields), and the sessions
// API answers 409 feature_unavailable. A change takes effect at the host's next hello: a deploy
// restarts every Durable Object and closes its host sockets, so each host reconnects.

import { CALVIN_API_PROTOCOL } from "./protocol.js";

/** The protocol a gated-off organization's host is welcomed with and treated as at most. */
export const GATED_PROTOCOL = CALVIN_API_PROTOCOL - 1;

export function computerApiEnabled(setting: string | undefined, organizationId: string | undefined): boolean {
  const list = (setting ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (list.includes("*")) return true;
  return Boolean(organizationId) && list.includes(organizationId!);
}
