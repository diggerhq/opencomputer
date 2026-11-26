// The `previews` Worker (work 074): routes `*.opencomputer.app/*` and
// `opencomputer.app/*`, and owns the PreviewDurableObject namespace. The
// computer object in `managed-agents` claims names here; this Worker only
// reads them on the request path.

import { PreviewDurableObject } from "./durable-object.js";
import { type PreviewEnv, createPreviewHandler } from "./worker.js";

export { PreviewDurableObject };

const handle = createPreviewHandler();

export default {
  fetch(request: Request, env: PreviewEnv, ctx: ExecutionContext): Promise<Response> {
    return handle(request, env, ctx);
  },
};
