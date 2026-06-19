import { Http, type HttpOptions } from "./http.js";
import { Session } from "./sessions.js";
import type { SessionData } from "./types.js";

export interface ConnectSessionOptions extends HttpOptions {
  sessionId: string;
  /** A session-scoped client token (read + steer). Safe in a browser; never the org key. */
  clientToken: string;
}

/**
 * Browser/edge entry point: connect to one session with a client token. Returns a
 * `Session` handle that can stream and steer that session — and nothing else.
 *
 *   const session = await connectSession({ sessionId, clientToken });
 *   for await (const ev of session.events()) render(ev);
 */
export async function connectSession(opts: ConnectSessionOptions): Promise<Session> {
  const http = new Http({ token: opts.clientToken }, opts);
  const data = await http.request<SessionData>("GET", `/sessions/${opts.sessionId}`);
  return new Session(http, data, opts.clientToken);
}
