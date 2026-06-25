import { Http, type HttpOptions } from "./http.js";
import { Agents } from "./agents.js";
import { Sessions } from "./sessions.js";
import { Credentials } from "./credentials.js";
import { Repos } from "./repos.js";

export interface OpenComputerOptions extends HttpOptions {
  /** Your OpenComputer org API key (server-side only — never ship it to a browser). */
  apiKey: string;
}

/**
 * Server-side client for Durable Agent Sessions. Holds the org API key and exposes the
 * management surface. For the browser, mint a client token and use `connectSession`.
 *
 *   const oc = new OpenComputer({ apiKey: process.env.OPENCOMPUTER_API_KEY! });
 *   const agent   = await oc.agents.create({ name, prompt, model, key });
 *   const session = await oc.sessions.create({ agent: agent.id, input });
 */
export class OpenComputer {
  readonly agents: Agents;
  readonly sessions: Sessions;
  readonly credentials: Credentials;
  readonly repos: Repos;

  constructor(opts: OpenComputerOptions) {
    const http = new Http({ apiKey: opts.apiKey }, opts);
    this.agents = new Agents(http);
    this.sessions = new Sessions(http);
    this.credentials = new Credentials(http);
    this.repos = new Repos(http);
  }
}
