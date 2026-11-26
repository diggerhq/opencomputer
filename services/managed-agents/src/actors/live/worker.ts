// The `opencomputer-live` Worker (tracks and threads, spec section 18.8): the script that holds
// the fan-out actor, apart from `managed-agents` so that a deploy of the API does not drop every
// socket. It has no route: the edge reaches Live through its Durable Object binding (`liveOf`).

export { LiveDurableObject } from "./durable-object.js";

export default {
  fetch(): Response {
    return new Response("Not found.", { status: 404 });
  },
};
