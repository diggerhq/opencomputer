import { Http, type HttpOptions } from "./http.js";
import { ClientSession } from "./sessions.js";

export interface ConnectSessionOptions extends HttpOptions {
  sessionId: string;
  /** A session-scoped client token (read + steer). Safe in a browser; never the org key. */
  clientToken: string;
}

/**
 * Browser/edge entry point: connect to one session with a client token. Returns a
 * `ClientSession` that can stream and steer that session — and nothing else.
 *
 *   const session = await connectSession({ sessionId, clientToken });
 *   for await (const ev of session.events()) render(ev);
 */
export async function connectSession(opts: ConnectSessionOptions): Promise<ClientSession> {
  const http = new Http({ token: opts.clientToken }, opts);
  // No metadata fetch: GET /sessions/:id is org-key scoped, so a client token can't read it.
  // The handle streams + steers directly — the routes a client token is authorized for.
  return new ClientSession(http, opts.sessionId, opts.clientToken);
}
