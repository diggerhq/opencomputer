// Delivery: one per organization and kind of destination, a reader of the occurrence stream
// (tracks and threads, spec section 36.5). The shell that ships with migration `v8`; see
// ../org/durable-object.ts.

import { DurableObject } from "cloudflare:workers";

import { unavailable } from "../actor/shell.js";

export class DeliveryDurableObject extends DurableObject {
  override fetch(): Response {
    return unavailable("Delivery");
  }
}
