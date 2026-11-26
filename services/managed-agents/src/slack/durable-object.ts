// Slack: one per organization, the link to its Slack workspace (tracks and threads, spec section
// 36.6). The shell that ships with migration `v8`; see ../org/durable-object.ts.

import { DurableObject } from "cloudflare:workers";

import { unavailable } from "../actor/shell.js";

export class SlackDurableObject extends DurableObject {
  override fetch(): Response {
    return unavailable("Slack");
  }
}
