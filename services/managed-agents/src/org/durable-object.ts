// Org: one per organization, the directory of its work (tracks and threads, spec section 36.1).
// This is the shell that ships with migration `v8`, ahead of the change itself: the class exists so
// the migration can be deployed and rolled back to on its own, and it answers 503 to everything.

import { DurableObject } from "cloudflare:workers";

import { unavailable } from "../actor/shell.js";

export class OrgDurableObject extends DurableObject {
  override fetch(): Response {
    return unavailable("Org");
  }

  override alarm(): void {}
}
