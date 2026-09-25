// Deployment capability manifests and readiness receipts — the shapes of
// `GET /deployments/<id>/capabilities` and `POST /deployments/<id>/readiness`
// documented at docs/agents/deployments.mdx. `oc.deployments.capabilities`
// and `oc.deployments.readiness` return them; they also type the CLI's
// `--json` output (`opencomputer deployments capabilities|readiness`).

import type { Environment } from "./types.js";
import {
  anyRecord,
  array,
  boolean,
  environment,
  jsonValue,
  nullable,
  number,
  object,
  oneOf,
  optional,
  string,
  ShapeError,
  type Shape,
} from "./shapes.js";

/**
 * The immutable capability manifest of a deployment: what the compiler and
 * the platform know about the build. The same deployment always returns the
 * same manifest and `manifestDigest`; no credential is ever included.
 */
export interface CapabilityManifest {
  schema: "opencomputer.deployment-capabilities/v1";
  projectId: string | null;
  agentId: string;
  deploymentId: string;
  alias?: string;
  /** `sha256:` digest of the deployed source artifact. */
  sourceDigest: string;
  /** `sha256:` attestation of the runtime image the deployment runs on. */
  runtimeImageDigest: string;
  runtimeImageVersion?: string;
  runtimeMode?: string;
  /** Models the agent source declares. A declaration is not the effective route; see readiness `model.route`. */
  models: Array<{ provider: string; model: string; [key: string]: unknown }>;
  defaultModel?: { provider: string; model: string } | null;
  tools: Array<{ id: string; [key: string]: unknown }>;
  resultSchemas: Array<{ toolId: string; schema: Record<string, unknown>; [key: string]: unknown }>;
  skills: Array<{ name: string; [key: string]: unknown }>;
  mcpServers: Array<{ id: string; [key: string]: unknown }>;
  subagents?: string[];
  /**
   * Connections as id + kind + policy, never their credentials. Whether a
   * connection is configured is an observation, reported by readiness.
   */
  connections: Array<{ id: string; kind: string; policy: Record<string, unknown>; [key: string]: unknown }>;
  memory: Array<{ id: string; [key: string]: unknown }>;
  regions: Array<{ scope: string; region: string; [key: string]: unknown }>;
  lifecycleCapabilities: Record<string, unknown>;
  egressCapabilities: Record<string, unknown>;
  createdAt: string;
  [key: string]: unknown;
}

export interface DeploymentCapabilities {
  manifest: CapabilityManifest;
  /** `sha256:` over the canonical JSON of `manifest`. Also returned as the `ETag`. */
  manifestDigest: string;
}

export type ReadinessCheckStatus = "pass" | "fail" | "skip";

/** One timestamped check of a readiness receipt. A required `fail` makes the receipt not ready. */
export interface ReadinessCheck {
  id: string;
  status: ReadinessCheckStatus;
  required: boolean;
  summary: string;
  detail: Record<string, unknown>;
  checkedAt: string;
  durationMs: number;
}

/**
 * A readiness receipt: provider-owned checks run at `checkedAt` against the
 * deployment's platform configuration. It does not run agent code and does
 * not contact any customer target, so a `ready` receipt proves capability,
 * not authorization to reach a target.
 */
export interface ReadinessReceipt {
  schema: "opencomputer.deployment-readiness/v1";
  projectId: string | null;
  agentId: string;
  deploymentId: string;
  sessionId: string | null;
  environment: Environment;
  checkedAt: string;
  /** The digest of the manifest the checks were evaluated against. */
  manifestDigest: string;
  probe: { mode: string; executesAgentCode: boolean; contactsCustomerTargets: boolean };
  checks: ReadinessCheck[];
  ready: boolean;
}

const digest: Shape<string> = (value, path) => {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new ShapeError(path, "a sha256: digest");
  }
  return value;
};

const modelDeclaration = object({ provider: string, model: string });

export const capabilityManifest: Shape<CapabilityManifest> = object({
  schema: oneOf("opencomputer.deployment-capabilities/v1"),
  projectId: nullable(string),
  agentId: string,
  deploymentId: string,
  alias: optional(string),
  sourceDigest: digest,
  runtimeImageDigest: digest,
  runtimeImageVersion: optional(string),
  runtimeMode: optional(string),
  models: array(modelDeclaration),
  defaultModel: optional(nullable(modelDeclaration)),
  tools: array(object({ id: string })),
  resultSchemas: array(object({ toolId: string, schema: anyRecord })),
  skills: array(object({ name: string })),
  mcpServers: array(object({ id: string })),
  subagents: optional(array(string)),
  connections: array(object({ id: string, kind: string, policy: anyRecord })),
  memory: array(object({ id: string })),
  regions: array(object({ scope: string, region: string })),
  lifecycleCapabilities: anyRecord,
  egressCapabilities: anyRecord,
  createdAt: string,
}) as Shape<CapabilityManifest>;

export const deploymentCapabilities: Shape<DeploymentCapabilities> = object({
  manifest: capabilityManifest,
  manifestDigest: digest,
});

export const readinessCheck: Shape<ReadinessCheck> = object({
  id: string,
  status: oneOf<ReadinessCheckStatus>("pass", "fail", "skip"),
  required: boolean,
  summary: string,
  detail: (value, path) => jsonValue(anyRecord(value, path), path) as Record<string, unknown>,
  checkedAt: string,
  durationMs: number,
});

export const readinessReceipt: Shape<ReadinessReceipt> = object({
  schema: oneOf("opencomputer.deployment-readiness/v1"),
  projectId: nullable(string),
  agentId: string,
  deploymentId: string,
  sessionId: nullable(string),
  environment,
  checkedAt: string,
  manifestDigest: digest,
  probe: object({ mode: string, executesAgentCode: boolean, contactsCustomerTargets: boolean }),
  checks: array(readinessCheck),
  ready: boolean,
});
