// `callService({ service: "linear" })` in a session a Linear connection owns
// (design 018, "Linear calls from the agent"). The managed services proxy
// answers it with the connection's app token instead of a person's grant;
// a managed user grant never resolves in such a session. Work 037 S4.

import type { ConnectionRequestInput, ConnectionRequestResult } from "../protocol.js";
import type { LinearConnectionStore } from "./linear-contract.js";

/** What the proxy answers: Linear's response in the usual envelope, or a refusal of its own. */
export type LinearServiceResult =
  | { outcome: "response"; response: ConnectionRequestResult }
  | { outcome: "refused"; status: number; code: string; message: string };

export type LinearServiceRequest = Pick<ConnectionRequestInput, "method" | "path" | "headers" | "body"> & {
  /**
   * Where the calling session runs. The connection that owns the session
   * must be bound to the same project, environment and agent before its
   * token is used.
   */
  session: { projectId: string; environment?: string; agentId: string };
};

const JSON_HEADERS = { "content-type": "application/json" };

function refused(status: number, code: string, message: string): LinearServiceResult {
  return { outcome: "refused", status, code, message };
}

/**
 * Only `POST /graphql` with a JSON body `{ query, variables? }`, the same
 * surface the managed user grant allows. Headers are not forwarded: the
 * token is attached by the connection store and the body is always JSON.
 */
export function parseLinearServiceRequest(
  request: Omit<LinearServiceRequest, "session">,
):
  | { ok: true; query: string; variables?: Record<string, unknown> }
  | { ok: false; result: LinearServiceResult } {
  const method = (request.method ?? "POST").toUpperCase();
  if (method !== "POST") {
    return {
      ok: false,
      result: refused(405, "linear_method_not_allowed", "Linear allows only POST /graphql"),
    };
  }
  let url: URL;
  try {
    url = new URL(request.path, "https://api.linear.app");
  } catch {
    return { ok: false, result: refused(403, "linear_path_not_allowed", "Linear allows only POST /graphql") };
  }
  if (
    !request.path.startsWith("/") ||
    request.path.includes("\\") ||
    url.origin !== "https://api.linear.app" ||
    url.pathname !== "/graphql" ||
    url.search
  ) {
    return { ok: false, result: refused(403, "linear_path_not_allowed", "Linear allows only POST /graphql") };
  }
  let body: unknown;
  try {
    body = JSON.parse(request.body ?? "");
  } catch {
    return {
      ok: false,
      result: refused(400, "invalid_linear_request", "Linear GraphQL requests require a JSON body"),
    };
  }
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    typeof (body as { query?: unknown }).query !== "string" ||
    !(body as { query: string }).query.trim()
  ) {
    return {
      ok: false,
      result: refused(400, "invalid_linear_request", "Linear GraphQL requests require a JSON object with a query"),
    };
  }
  const variables = (body as { variables?: unknown }).variables;
  if (variables !== undefined && variables !== null && (typeof variables !== "object" || Array.isArray(variables))) {
    return {
      ok: false,
      result: refused(400, "invalid_linear_request", "Linear GraphQL variables must be an object"),
    };
  }
  return {
    ok: true,
    query: (body as { query: string }).query,
    ...(variables ? { variables: variables as Record<string, unknown> } : {}),
  };
}

/**
 * One request through the connection store (`graphql`: token attached,
 * refreshed near expiry and once on a 401). GraphQL errors arrive with HTTP
 * 200 and reach the caller inside the body, as from Linear itself.
 */
export async function linearServiceRequest(
  store: LinearConnectionStore,
  connectionId: string,
  request: LinearServiceRequest,
): Promise<LinearServiceResult> {
  const connection = store.get(connectionId);
  if (!connection) {
    return refused(
      409,
      "linear_connection_unavailable",
      "This session's Linear connection is missing; reconnect it in the project's connections",
    );
  }
  if (
    connection.projectId !== request.session.projectId ||
    connection.environment !== request.session.environment ||
    connection.agentId !== request.session.agentId
  ) {
    return refused(
      403,
      "linear_connection_mismatch",
      "This session's Linear connection is not bound to the session's project, environment and agent",
    );
  }
  const parsed = parseLinearServiceRequest(request);
  if (!parsed.ok) return parsed.result;
  const result = await store.graphql(connectionId, {
    query: parsed.query,
    ...(parsed.variables ? { variables: parsed.variables } : {}),
  });
  switch (result.outcome) {
    case "ok":
      return {
        outcome: "response",
        response: {
          status: 200,
          headers: JSON_HEADERS,
          body: JSON.stringify({
            data: result.data ?? null,
            ...(result.errors?.length ? { errors: result.errors } : {}),
          }),
        },
      };
    case "permanent":
      return {
        outcome: "response",
        response: {
          status: result.status,
          headers: JSON_HEADERS,
          body: JSON.stringify({ errors: [{ message: result.message }] }),
        },
      };
    case "transient":
      if (result.status !== undefined) {
        return {
          outcome: "response",
          response: {
            status: result.status,
            headers: {
              ...JSON_HEADERS,
              ...(result.retryAfterSeconds !== undefined
                ? { "retry-after": String(result.retryAfterSeconds) }
                : {}),
            },
            body: JSON.stringify({ errors: [{ message: result.message }] }),
          },
        };
      }
      return refused(502, "linear_request_failed", result.message);
    case "unavailable":
      return refused(
        409,
        "linear_connection_unavailable",
        `This session's Linear connection is ${result.reason === "not_found" ? "missing" : result.reason}; reconnect it in the project's connections`,
      );
  }
}
