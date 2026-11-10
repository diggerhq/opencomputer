// The `opencomputer-wire` Worker (work 084): `wire.opencomputer.dev`, its own
// deploy (wrangler.wire.jsonc). Checks the credential on the WebSocket
// upgrade and the workspace file routes, signs for the computer's relay, and
// hands the tunnel's response back; see worker.ts.

import { type WireEnv, createWireHandler } from "./worker.js";

const handle = createWireHandler();

export default {
  fetch(request: Request, env: WireEnv, ctx: ExecutionContext): Promise<Response> {
    return handle(request, env, ctx);
  },
};
