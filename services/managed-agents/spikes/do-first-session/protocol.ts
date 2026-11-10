export type SpikeValue = null | boolean | number | string | SpikeValue[] | {
  [key: string]: SpikeValue;
};

export type SpikeOperation =
  | {
      id: string;
      kind: "edge.compute";
      input: { operation: "concat"; values: string[] };
    }
  | {
      id: string;
      kind:
        | "runtime.agent"
        | "sandbox.fs"
        | "sandbox.exec"
        | "sandbox.browser";
      input: Record<string, SpikeValue>;
    };

export interface CapabilityFault {
  type: "capability.fault";
  sessionId: string;
  deploymentId: string;
  operationId: string;
  operationIndex: number;
  capability: "agent_runtime" | "fs" | "exec" | "browser";
  escalationEpoch: number;
}

export interface SpikeExecutionSnapshot {
  sessionId: string;
  deploymentId: string;
  mode:
    | "running_edge"
    | "awaiting_runtime"
    | "running_sandbox"
    | "completed";
  continuation: number;
  escalationEpoch: number;
  fault?: CapabilityFault;
  results: Array<{
    operationId: string;
    executor: "edge" | "sandbox";
    value: SpikeValue;
  }>;
  metrics: {
    runtimeStarts: number;
    edgeOperations: number;
    sandboxOperations: number;
  };
}

export function capabilityFor(
  operation: SpikeOperation,
): CapabilityFault["capability"] | null {
  if (operation.kind === "runtime.agent") return "agent_runtime";
  if (operation.kind === "sandbox.fs") return "fs";
  if (operation.kind === "sandbox.exec") return "exec";
  if (operation.kind === "sandbox.browser") return "browser";
  return null;
}

export function executeDeterministicOperation(
  operation: SpikeOperation,
): SpikeValue {
  if (operation.kind === "edge.compute") {
    return operation.input.values.join("");
  }
  return { kind: operation.kind, input: operation.input };
}
