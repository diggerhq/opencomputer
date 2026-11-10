import type {
  DocumentPage,
  MemoryOperations,
  ReadOutcome,
  RecallOutcome,
  RejectReason,
  SaveInput,
  SaveResult,
} from "../edge/memory-contract.js";

/**
 * The one seam between the Workerd host and project memory. Every memory
 * operation the host performs for an executing session goes through it:
 * recall before render, the three fixed tools at execution time. It is
 * scoped to one session's grants in one Memory Durable Object, so callers
 * name resources, never sessions or objects.
 *
 * The production implementation is an RPC stub over the `MEMORY` namespace.
 * Tests replace the factory on the session object with a scripted fake.
 */
export interface MemoryClient {
  recall(resource: string): Promise<RecallOutcome>;
  save(resource: string, input: SaveInput, expectedRevision: string): Promise<SaveResult>;
  readDocument(resource: string, id: string): Promise<ReadOutcome>;
  listCollection(
    resource: string,
    cursor?: string,
  ): Promise<DocumentPage | { kind: "rejected"; reason: RejectReason }>;
}

/** Which grants a client speaks for: one managed session in one Memory Durable Object. */
export interface MemoryScope {
  /** `memoryObjectName(accountId, projectId, environment)`; chosen by admission, never by the host. */
  objectName: string;
  /** The managed session id the grants were issued to. */
  sessionId: string;
}

export type MemoryClientFactory = (scope: MemoryScope) => MemoryClient;

type SessionOperations = Pick<
  MemoryOperations,
  "recall" | "save" | "readDocument" | "listCollection"
>;

/**
 * The executing-session half of the Memory Durable Object, as seen through
 * an RPC stub. Only these four operations are reachable from the host; the
 * owner and control-plane operations are not bound here on purpose.
 */
type MemoryStub = DurableObjectStub & SessionOperations;

/** Production factory: one RPC stub per Memory Durable Object name. */
export function durableObjectMemoryClients(
  namespace: DurableObjectNamespace,
): MemoryClientFactory {
  return (scope) => {
    const stub = namespace.get(
      namespace.idFromName(scope.objectName),
    ) as unknown as MemoryStub;
    return {
      recall: (resource) => stub.recall(scope.sessionId, resource),
      save: (resource, input, expectedRevision) =>
        stub.save(scope.sessionId, resource, input, expectedRevision),
      readDocument: (resource, id) => stub.readDocument(scope.sessionId, resource, id),
      listCollection: (resource, cursor) =>
        stub.listCollection(scope.sessionId, resource, cursor),
    };
  };
}

/** Used when no `MEMORY` namespace is bound: every operation is a configuration error. */
export function unboundMemoryClients(): MemoryClientFactory {
  return () => {
    const fail = () =>
      Promise.reject(new Error("The MEMORY Durable Object namespace is not bound"));
    return {
      recall: fail,
      save: fail,
      readDocument: fail,
      listCollection: fail,
    };
  };
}
