// The telemetry trace context that travels with a message.

/**
 * Telemetry trace context (work 054; calvin src/protocol.ts `TraceContext`):
 * minted per Slack message at `message.received`, kept in the Slack queue and
 * dispatch payloads, and sent on `deliver`. The host adds its own stamps
 * before forwarding to the runner. Optional everywhere: older hosts ignore it
 * and the protocol version is unchanged.
 */
export interface CalvinTraceContext {
  /** trace_id, UUIDv7. */
  id: string;
  /** ms since epoch: the frontend's own time for the message (Slack ts × 1000). */
  sentAt: number;
  /** Gateway wall clock at message.received. */
  receivedAt: number;
  /** Gateway wall clock when this delivery was sent to the host. */
  dispatchedAt?: number;
  surface: string;
  surfaceWorkspaceId: string;
  conversationId: string;
  personId: string;
  surfaceEventId?: string;
  gatewayVersion?: string;
  gatewayRegion?: string;
  gatewaySessionId?: string;
  synthetic?: boolean;
  // Added by the host before forwarding to the runner:
  path?: "warm" | "new" | "resume" | "prewarmed";
  hostReceivedAt?: number;
  runnerReadyAt?: number;
  forkMs?: number;
  launchMs?: number;
}
