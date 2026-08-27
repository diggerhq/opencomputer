export type DataValue =
  | null
  | boolean
  | number
  | string
  | DataValue[]
  | { [key: string]: DataValue };

export interface ActionRequestRecord {
  schemaVersion: 1;
  actionId: string;
  definitionId: string;
  server: string;
  tool: string;
  effect: "read" | "write";
  duration: "inline" | "deferred";
  projectId: string;
  environment: string;
  agentId: string;
  sessionId: string;
  deploymentDigest: string;
  createdAt: string;
  input: Record<string, DataValue>;
}

export type ActionDisposition =
  | { action: "allow" }
  | { action: "deny"; reason: string }
  | {
      action: "require-approval";
      approval: { role: string; reason?: string };
    }
  | { action: "defer"; until: string }
  | { action: "route"; executor: string };

export interface ActionDecisionRecord {
  schemaVersion: 1;
  actionId: string;
  requestOid: string;
  policyBundleDigest: string;
  decidedAt: string;
  disposition: ActionDisposition;
}

export interface ActionResultRecord {
  schemaVersion: 1;
  actionId: string;
  requestOid: string;
  decisionOid: string;
  completedAt: string;
  secretVersions: Array<{ alias: string; name: string; version: string }>;
  outcome:
    | { status: "succeeded"; output: DataValue }
    | { status: "denied"; reason: string }
    | { status: "pending"; reason: string }
    | { status: "failed"; error: string };
}

export interface CompiledActionDefinition {
  id: string;
  server: string;
  tool: string;
  description?: string;
  effect: "read" | "write";
  duration: "inline" | "deferred";
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  secrets: Record<string, string>;
}

export interface CompiledActionManifest {
  entry: string;
  definitions: CompiledActionDefinition[];
}
