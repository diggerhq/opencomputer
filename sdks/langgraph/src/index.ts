// @opencomputer/langgraph — run a LangGraph.js graph as an OpenComputer agent.
// A standalone runtime (no @flue/runtime dependency): its own session transport,
// per-session Durable Object, durable checkpointer, and model-gateway wiring.
//
// - createLangGraphRuntime({ compile }) -> { fetch, SessionDO }: the Worker host +
//   the per-session Durable Object that runs your graph. Wire both in your app.ts.
// - DurableObjectSaver: a LangGraph BaseCheckpointSaver on Durable Object storage,
//   so a thread's state survives isolate eviction and resumes across invocations.
// - ocModel(env): a LangChain Anthropic model pointed at the OC model gateway
//   (managed key + per-session metering), built per-request for the token seam.
export { createLangGraphRuntime } from "./runtime.js";
export type {
  CompiledGraph,
  DurableObjectNamespace,
  DurableObjectState,
  LangGraphRuntime,
  LangGraphRuntimeOptions,
  SessionDurableObject,
} from "./runtime.js";
export { DurableObjectSaver } from "./checkpointer.js";
export type { DOStorage } from "./checkpointer.js";
export { ocModel } from "./gateway.js";
export type { OcGatewayEnv, OcModelOptions } from "./gateway.js";
