import type { DoFirstSessionDurableObject } from "./session-do.js";

interface Env {
  DO_FIRST_SESSIONS: DurableObjectNamespace<DoFirstSessionDurableObject>;
}

export { DoFirstSessionDurableObject } from "./session-do.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/sessions\/([^/]+)\/(initialize|edge|runtime\/ack|runtime\/result|snapshot)$/);
    if (!match?.[1] || !match[2]) return Response.json({ error: "not_found" }, { status: 404 });
    const session = env.DO_FIRST_SESSIONS.getByName(decodeURIComponent(match[1]));
    try {
      if (request.method === "POST" && match[2] === "initialize") {
        return Response.json(await session.initialize(await request.json()));
      }
      if (request.method === "POST" && match[2] === "edge") {
        return Response.json(await session.runEdge());
      }
      if (request.method === "POST" && match[2] === "runtime/ack") {
        const input = await request.json<{ escalationEpoch: number }>();
        return Response.json(await session.acknowledgeRuntime(input.escalationEpoch));
      }
      if (request.method === "POST" && match[2] === "runtime/result") {
        return Response.json(await session.commitRuntimeResult(await request.json()));
      }
      if (request.method === "GET" && match[2] === "snapshot") {
        return Response.json(await session.snapshot());
      }
      return Response.json({ error: "method_not_allowed" }, { status: 405 });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 409 },
      );
    }
  },
} satisfies ExportedHandler<Env>;
