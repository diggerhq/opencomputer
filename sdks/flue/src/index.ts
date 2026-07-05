// @opencomputer/flue — make a stock Flue agent OpenComputer-native (design 013 §4/§5).
// - useOcGateway + route + DEFAULT_MODEL: point managed anthropic at the OC gateway; HTTP-transport opt-in.
// - ocSandbox: a durable OC-fleet sandbox as the agent's SandboxApi.
// - ocRepoTools: publish/repo tools (repo plane).
// - installOcObserver: forward lifecycle/usage to OC_INGEST.
// Default hosting app is at `@opencomputer/flue/app`; `@opencomputer/flue/wire` is the telemetry-only
// side-effect for apps with their own app.ts.

export { useOcGateway, route, DEFAULT_MODEL } from "./gateway.js";
export type { OcEnv } from "./gateway.js";
export { ocSandbox, WORKSPACE_CWD } from "./sandbox.js";
export type { OcSandboxEnv } from "./sandbox.js";
export { installOcObserver } from "./observe.js";
export { ocRepoTools } from "./tools.js";
export type { OcRepoEnv } from "./tools.js";
