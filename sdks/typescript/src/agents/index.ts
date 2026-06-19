export { OpenComputer, type OpenComputerOptions } from "./client.js";
export { connectSession, type ConnectSessionOptions } from "./connect.js";

export { Sessions, Session } from "./sessions.js";
export type { CreateSessionParams, StreamOptions, Envelope, ListPage } from "./sessions.js";
export { Agents } from "./agents.js";
export type { CreateAgentParams, UpdateAgentParams, Page } from "./agents.js";
export { Credentials } from "./credentials.js";
export type { CreateCredentialParams } from "./credentials.js";

export * from "./types.js";
export * from "./errors.js";
