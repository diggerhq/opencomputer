import { isProjectEnvironmentName } from "./edge/project-scope.js";
import type { SessionIdentity, ToolInvocationIdentity } from "./protocol.js";

const SESSION_IDENTITY_FIELDS = [
  "projectId",
  "agentId",
  "deploymentId",
  "sessionId",
] as const;

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * The host's logical call id. Length-prefixing makes the tuple unambiguous
 * without trusting the provider label as an id in its own right. Every host
 * that knows the admitted turn can derive the same value before execution,
 * so durable events and the operation ledger agree without coordination.
 */
export function hostToolCallId(input: {
  sessionId: string;
  turnId: string;
  messageId: string;
  providerCallId: string;
}): string {
  const part = (value: string): string => `${String(value.length)}:${value}`;
  return `call:${part(input.sessionId)}:${part(input.turnId)}:${part(input.messageId)}:${part(input.providerCallId)}`;
}

/**
 * The session part of a host identity, from a payload one host sent
 * another; undefined for anything that is not a complete one.
 */
export function parseSessionIdentity(value: unknown): SessionIdentity | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!SESSION_IDENTITY_FIELDS.every((field) => nonEmpty(record[field]))) return undefined;
  if (!isProjectEnvironmentName(record.environment)) return undefined;
  return {
    projectId: record.projectId as string,
    environment: record.environment,
    agentId: record.agentId as string,
    deploymentId: record.deploymentId as string,
    sessionId: record.sessionId as string,
  };
}

/** A complete host identity from a payload one host sent another; undefined otherwise. */
export function parseToolInvocationIdentity(value: unknown): ToolInvocationIdentity | undefined {
  const session = parseSessionIdentity(value);
  if (!session) return undefined;
  const record = value as Record<string, unknown>;
  if (
    !nonEmpty(record.turnId) ||
    !nonEmpty(record.messageId) ||
    !nonEmpty(record.toolCallId) ||
    !nonEmpty(record.providerCallId)
  ) {
    return undefined;
  }
  return {
    ...session,
    turnId: record.turnId,
    messageId: record.messageId,
    toolCallId: record.toolCallId,
    providerCallId: record.providerCallId,
  };
}

/**
 * The identity as a tool sees it: a frozen copy with exactly the eight
 * fields, so the object handed to `run` can be neither changed by the tool
 * nor carry anything a host payload had next to them.
 */
export function freezeToolInvocationIdentity(
  identity: ToolInvocationIdentity,
): ToolInvocationIdentity {
  return Object.freeze({
    projectId: identity.projectId,
    environment: identity.environment,
    agentId: identity.agentId,
    deploymentId: identity.deploymentId,
    sessionId: identity.sessionId,
    turnId: identity.turnId,
    messageId: identity.messageId,
    toolCallId: identity.toolCallId,
    providerCallId: identity.providerCallId,
  });
}
