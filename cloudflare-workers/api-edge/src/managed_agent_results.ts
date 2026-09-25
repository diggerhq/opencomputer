/**
 * The public shape of a session's result history: every result an agent
 * committed, one immutable record per tool call, readable by session, by turn
 * or by id. `data` is the application's own JSON and passes through verbatim;
 * the rest of the record is provenance the platform assigned, listed by name
 * so nothing private can ride along.
 */

/** `/sessions/{id}/results`, `/sessions/{id}/turns/{turnId}/results` and `/sessions/{id}/results/{resultId}`. */
export const SESSION_RESULTS_ROUTE =
  /^\/sessions\/[^/]+(?:\/turns\/[^/]+)?\/results(?:\/[^/]+)?$/;

/** The single-record route: `/sessions/{id}/results/{resultId}`. */
export const SESSION_RESULT_ROUTE = /^\/sessions\/[^/]+\/results\/[^/]+$/;

export function isSessionResultsRoute(method: string, suffix: string): boolean {
  return method === "GET" && SESSION_RESULTS_ROUTE.test(suffix);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function publicSessionResultRecord(value: unknown): unknown {
  const result = record(value);
  if (!result) return null;
  return {
    resultId: result.resultId,
    projectId: result.projectId,
    environment: result.environment ?? null,
    agentId: result.agentId,
    deploymentId: result.deploymentId,
    sessionId: result.sessionId,
    turnId: result.turnId,
    messageId: optionalString(result.messageId) ?? null,
    toolCallId: result.toolCallId,
    resultTool: result.resultTool,
    schemaId: optionalString(result.schemaId) ?? null,
    schemaDigest: optionalString(result.schemaDigest) ?? null,
    dataDigest: result.dataDigest,
    data: result.data,
    createdAt: result.createdAt,
  };
}

export function publicSessionResultsBody(
  suffix: string,
  body: Record<string, unknown>,
): unknown {
  if (SESSION_RESULT_ROUTE.test(suffix)) {
    return publicSessionResultRecord(body);
  }
  return {
    results: Array.isArray(body.results)
      ? body.results.map(publicSessionResultRecord)
      : [],
    nextCursor: optionalString(body.nextCursor) ?? null,
  };
}
