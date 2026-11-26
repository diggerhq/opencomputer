// GET /v1/computer/host?organizationId=<id>: the host's WebSocket, checked against the organization's host
// token and handed to its Computer.

import type { ComputerEdgeEnv } from "../../actors/computer/config.js";
import { bearerToken, hostAuthorized } from "../../actors/computer/host-link/host-token.js";
import { problem } from "../../edge/http.js";
import { computerOf, computers, reservedName } from "../computer-objects.js";

export async function hostRoute(request: Request, env: ComputerEdgeEnv, url: URL): Promise<Response> {
  const organizationId = url.searchParams.get("organizationId");
  // Pool computers (`pool-<random>`) connect here too, with their own derived token.
  if (!computers(env) || (organizationId !== null && reservedName(organizationId)) || !(await hostAuthorized(bearerToken(request), organizationId, env.COMPUTER_HOST_TOKEN_KEY))) {
    console.warn(JSON.stringify({ level: "warn", event: "computer.host_rejected", organizationId }));
    return problem(401, "unauthorized", "Host authentication required");
  }
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return problem(426, "upgrade_required", "WebSocket upgrade required");
  }
  return computerOf(env, organizationId!).fetch(request);
}
