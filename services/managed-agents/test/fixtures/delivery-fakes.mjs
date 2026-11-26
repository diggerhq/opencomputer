// Svix, faked: the part of its API Delivery(webhook) calls, kept in memory. A message to an app
// whose uid contains `flaky` is answered 503 twice before it is taken. `GET https://api.svix.com/_test`
// answers every app's endpoints and the messages taken.
const apps = new Map();
const eventTypes = new Set();
const messages = [];
const failures = new Map();

const json = (body, status = 200) => Response.json(body, { status });
const missing = () => json({ code: "not_found", detail: "Entity not found" }, 404);

export async function fakeDeliveryOutbound(request) {
  const url = new URL(request.url);
  if (url.hostname !== "api.svix.com") return new Response("no such host", { status: 502 });
  if (url.pathname === "/_test") return json({ apps: Object.fromEntries([...apps].map(([uid, app]) => [uid, [...app.endpoints.values()]])), messages });
  if (request.headers.get("authorization") !== "Bearer testsk_delivery") return json({ code: "authentication_failed" }, 401);
  const body = request.method === "GET" || request.method === "DELETE" ? undefined : await request.json();
  const path = url.pathname.replace(/\/$/, "").split("/").slice(3); // after /api/v1
  if (path[0] === "event-type") {
    if (eventTypes.has(body.name)) return json({ code: "conflict" }, 409);
    eventTypes.add(body.name);
    return json({ name: body.name }, 201);
  }
  if (path[0] !== "app") return missing();
  if (path.length === 1) {
    if (!apps.has(body.uid)) apps.set(body.uid, { endpoints: new Map() });
    return json({ id: `app_${body.uid}`, uid: body.uid });
  }
  const app = apps.get(path[1]);
  if (!app) return missing();
  if (path[2] === "msg") {
    const seen = failures.get(path[1]) ?? 0;
    if (path[1].includes("flaky") && seen < 2) {
      failures.set(path[1], seen + 1);
      return json({ code: "unavailable" }, 503);
    }
    const key = request.headers.get("idempotency-key");
    const prior = messages.find((m) => m.app === path[1] && m.idempotencyKey === key);
    if (prior) return json({ id: prior.id, eventId: prior.eventId });
    const message = { id: `msg_${messages.length + 1}`, app: path[1], idempotencyKey: key, ...body };
    messages.push(message);
    return json({ id: message.id, eventId: message.eventId }, 202);
  }
  if (path[2] !== "endpoint") return missing();
  const validate = (params) =>
    !/^https:\/\//.test(params.url) ? json({ code: "validation", detail: "url" }, 422)
    : (params.filterTypes ?? []).some((type) => !eventTypes.has(type)) ? json({ code: "validation", detail: "filterTypes" }, 422)
    : null;
  if (path.length === 3) {
    if (request.method === "GET") return json({ data: [...app.endpoints.values()], done: true });
    const bad = validate(body);
    if (bad) return bad;
    if (app.endpoints.has(body.uid)) return json({ code: "conflict" }, 409);
    const endpoint = { id: `ep_${body.uid}`, ...body, disabled: body.disabled ?? false, secret: undefined };
    app.endpoints.set(body.uid, endpoint);
    app[`secret:${body.uid}`] = `whsec_${btoa(body.uid)}`;
    return json(endpoint, 201);
  }
  const endpoint = app.endpoints.get(path[3]);
  if (!endpoint) return missing();
  if (path[4] === "secret") return json({ key: app[`secret:${path[3]}`] });
  if (request.method === "GET") return json(endpoint);
  if (request.method === "DELETE") {
    app.endpoints.delete(path[3]);
    return new Response(null, { status: 204 });
  }
  const bad = validate(body);
  if (bad) return bad;
  const updated = { id: endpoint.id, ...body, disabled: body.disabled ?? false };
  app.endpoints.set(path[3], updated);
  return json(updated);
}
