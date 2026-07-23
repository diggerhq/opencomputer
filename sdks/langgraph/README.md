# @opencomputer/langgraph

Run a [LangGraph.js](https://langchain-ai.github.io/langgraphjs/) graph as an
OpenComputer agent. A **standalone runtime** — its own session transport, one Durable
Object per session, a durable checkpointer, and model-gateway wiring — with **no
`@flue/runtime` dependency**. Scaffold one with:

```
oc agent init ./my-graph --runtime langgraph
```

## What it gives you

- **`createLangGraphRuntime({ compile })`** → `{ fetch, SessionDO }`. Mount both in your
  `src/app.ts`: `fetch` is the Worker host (its transport: `/health`, and
  `POST|GET /agents/:agent/:session`), `SessionDO` is the per-session Durable Object that
  runs your graph. `compile(checkpointer)` is your `StateGraph.compile({ checkpointer })`
  — the runtime passes in a durable checkpointer per session.
- **`DurableObjectSaver`** — a LangGraph `BaseCheckpointSaver` on Durable Object storage,
  so a thread's state survives isolate eviction and resumes across invocations.
  (Postgres/Redis savers can't run on the Workers runtime — long-lived TCP.)
- **`ocModel(env, opts?)`** — a LangChain Anthropic model pointed at the OC gateway when
  deployed (`OC_GATEWAY` + `OC_SESSION_TOKEN`) or `ANTHROPIC_API_KEY` locally. Build it
  **inside a node from the request env** (`config.configurable.env`), not at module init
  — the token is a per-request secret.

```ts
// src/app.ts
import { createLangGraphRuntime } from "@opencomputer/langgraph";
import { compile } from "./graph.js";
const runtime = createLangGraphRuntime({ compile });
export default { fetch: runtime.fetch };
export const LangGraphSession = runtime.SessionDO; // matches wrangler.jsonc class_name
```

## Transport contract

The server-side langgraph dispatch targets this:

- `GET /health` → `{ status: "ok" }`
- `POST /agents/:agent/:session` body `{ input? , messages? }` → runs the graph for that
  session's thread, returns `{ session, status, state, events }`
- `GET /agents/:agent/:session?offset=N` → `{ session, offset, events }` (replay)

Each `(agent, session)` maps to one Durable Object; the graph is compiled there with a
`DurableObjectSaver`.

## Status

Runtime (host + Session DO + `DurableObjectSaver` + `ocModel`) is built and typechecks.
**Remaining for a live deploy:** (1) a `wrangler`-based build step wired into
`oc agent deploy`'s langgraph branch; (2) the server-side dispatch registering the
`langgraph` family and routing sessions to the deployed Worker; (3) an integration test
(miniflare) exercising the checkpointer + transport end to end.
