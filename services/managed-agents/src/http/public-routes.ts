// The computer's edge routes reachable without the edge assertion: they carry their own auth.

import type { ComputerEdgeEnv } from "../actors/computer/config.js";
import { connectWithCode } from "./connect/with-code.js";
import { hostRoute } from "./host/upgrade.js";

/** Provider and host routes, reachable without the edge assertion; null when the path is not one of them. */
export async function routeComputerPublic(
  request: Request,
  env: ComputerEdgeEnv,
  _context: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/v1/computer/host" && request.method === "GET") return hostRoute(request, env, url);
  if (url.pathname === "/v1/computer/agent/connect" && request.method === "POST") return connectWithCode(request, env);
  return null;
}
