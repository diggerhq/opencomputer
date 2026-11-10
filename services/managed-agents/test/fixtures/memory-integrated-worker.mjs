// The integrated memory test worker: the edge worker (Account, Session and
// Memory Durable Objects, owner routes, session create and turn routes) and
// the Workerd session runtime in one script, so a managed session created
// through the edge reaches the real host over the WORKERD_RUNTIME service
// binding (bound to this same worker) and the host reaches the same Memory
// Durable Object the edge admitted the session against. Plain JavaScript on
// purpose: each side is type-checked by its own tsconfig.
import edge, {
  AccountDurableObject,
  MemoryDurableObject,
  SessionDurableObject,
} from "../../src/edge/index.ts";
import runtime, { OpenCodeSessionDurableObject } from "../../src/workerd-runtime/index.ts";

export {
  AccountDurableObject,
  MemoryDurableObject,
  OpenCodeSessionDurableObject,
  SessionDurableObject,
};

export default {
  fetch(request, env, context) {
    return new URL(request.url).hostname === "workerd-runtime.invalid"
      ? runtime.fetch(request, env)
      : edge.fetch(request, env, context);
  },
};
