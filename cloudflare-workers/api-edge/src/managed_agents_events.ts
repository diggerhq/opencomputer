// Long-poll event pages and HTTPS event delivery (docs/agents/events.mdx,
// docs/agents/event-delivery.mdx). The event page's cursor and terminal
// metadata are platform envelope and pass through by name; a delivery record
// is projected onto its documented public shape.

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * `cursor`, `session`, `turn` and `waitExpired` of an event page, when the
 * backend sent them. Older backends send only `events`; the metadata is
 * then absent rather than invented.
 */
export function publicEventPageMetadata(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const cursor = record(body.cursor);
  if (cursor) {
    const requestedAfter = finiteNumber(cursor.requestedAfter);
    const nextAfter = finiteNumber(cursor.nextAfter);
    const highWatermark = finiteNumber(cursor.highWatermark);
    if (
      requestedAfter !== undefined &&
      nextAfter !== undefined &&
      highWatermark !== undefined
    ) {
      out.cursor = { requestedAfter, nextAfter, highWatermark };
    }
  }
  const session = record(body.session);
  if (
    session &&
    typeof session.status === "string" &&
    typeof session.terminal === "boolean"
  ) {
    out.session = { status: session.status, terminal: session.terminal };
  }
  if (body.turn === null) {
    out.turn = null;
  } else {
    const turn = record(body.turn);
    if (
      turn &&
      typeof turn.id === "string" &&
      typeof turn.status === "string" &&
      typeof turn.terminal === "boolean"
    ) {
      out.turn = { id: turn.id, status: turn.status, terminal: turn.terminal };
    }
  }
  if (typeof body.waitExpired === "boolean") {
    out.waitExpired = body.waitExpired;
  }
  return out;
}

const HTTPS_SUBSCRIPTION_OPERATIONS_ROUTE =
  /^\/projects\/[^/]+\/event-subscriptions\/[^/]+\/(deliveries|replay|pause|resume|rotate-secret)$/;
const HTTPS_SUBSCRIPTION_DELIVERY_ROUTE =
  /^\/projects\/[^/]+\/event-subscriptions\/[^/]+\/deliveries\/[^/]+$/;

/** Deliveries list/detail, replay, pause, resume and secret rotation. */
export function isEventDeliveryRoute(method: string, suffix: string): boolean {
  const operation = suffix.match(HTTPS_SUBSCRIPTION_OPERATIONS_ROUTE)?.[1];
  if (operation === "deliveries") return method === "GET";
  if (operation) return method === "POST";
  return method === "GET" && HTTPS_SUBSCRIPTION_DELIVERY_ROUTE.test(suffix);
}

export function isEventDeliveriesListRoute(
  method: string,
  suffix: string,
): boolean {
  return (
    method === "GET" &&
    suffix.match(HTTPS_SUBSCRIPTION_OPERATIONS_ROUTE)?.[1] === "deliveries"
  );
}

export function isEventDeliveryDetailRoute(
  method: string,
  suffix: string,
): boolean {
  return method === "GET" && HTTPS_SUBSCRIPTION_DELIVERY_ROUTE.test(suffix);
}

export function isEventDeliveryReplayRoute(
  method: string,
  suffix: string,
): boolean {
  return (
    method === "POST" &&
    suffix.match(HTTPS_SUBSCRIPTION_OPERATIONS_ROUTE)?.[1] === "replay"
  );
}

export function isEventSubscriptionStateRoute(
  method: string,
  suffix: string,
): boolean {
  const operation = suffix.match(HTTPS_SUBSCRIPTION_OPERATIONS_ROUTE)?.[1];
  return (
    method === "POST" &&
    (operation === "pause" ||
      operation === "resume" ||
      operation === "rotate-secret")
  );
}

/**
 * One HTTPS delivery as documented. `error` is the platform's bounded
 * description of the last failure and carries no receiver response body.
 */
export function publicEventDelivery(value: unknown): Record<string, unknown> {
  const delivery = record(value) ?? {};
  return {
    id: delivery.id,
    subscriptionId: delivery.subscriptionId,
    projectId: delivery.projectId,
    environment: delivery.environment,
    agentId: delivery.agentId,
    sessionId: delivery.sessionId,
    turnId: delivery.turnId,
    eventId: delivery.eventId,
    eventType: delivery.eventType,
    sequence: delivery.sequence,
    occurredAt: delivery.occurredAt,
    status: delivery.status,
    attempt: delivery.attempt,
    ...(typeof delivery.nextAttemptAt === "string"
      ? { nextAttemptAt: delivery.nextAttemptAt }
      : {}),
    ...(typeof delivery.lastAttemptAt === "string"
      ? { lastAttemptAt: delivery.lastAttemptAt }
      : {}),
    ...(typeof delivery.responseStatus === "number"
      ? { responseStatus: delivery.responseStatus }
      : {}),
    ...(typeof delivery.error === "string" ? { error: delivery.error } : {}),
    ...(typeof delivery.deliveredAt === "string"
      ? { deliveredAt: delivery.deliveredAt }
      : {}),
    ...(typeof delivery.replayOf === "string"
      ? { replayOf: delivery.replayOf }
      : {}),
    createdAt: delivery.createdAt,
    updatedAt: delivery.updatedAt,
  };
}

export function publicEventDeliveriesPage(
  body: Record<string, unknown>,
): Record<string, unknown> {
  return {
    deliveries: Array.isArray(body.deliveries)
      ? body.deliveries.map(publicEventDelivery)
      : [],
    ...(typeof body.nextCursor === "string"
      ? { nextCursor: body.nextCursor }
      : {}),
  };
}
