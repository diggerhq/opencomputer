// `GET /live` (spec 38).

import { liveOf, type ActorEnv } from "../../actors/addresses.js";
import { liveRequest } from "../../actors/live/contract.js";
import type { Principal } from "../../auth/principal.js";
import type { Reply } from "./reply.js";

/** `GET /live` (spec 38): the upgrade, passed to the organization's Live with the principal verified here. */
export async function liveUpgrade(request: Request, env: ActorEnv, p: Principal, out: Reply): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return out.error(426, "upgrade_required", "GET /live is a WebSocket.");
  return liveOf(env, p.org).fetch(liveRequest(request, p));
}
