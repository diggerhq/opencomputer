// Slack's Web API, faked for the Slack actor's tests: everyone is a full member of team T1 except
// users whose id starts with `UGUEST`; every post succeeds with a fresh ts, except into a channel whose
// id starts with `CRATE`, which Slack rate-limits (HTTP 429, Retry-After 7 s).
let ts = 1000;
/** Top-level posts by channel, oldest first: a channel's history (with metadata when asked for). */
const history = new Map();
export async function fakeSlackOutbound(request) {
  const url = new URL(request.url);
  if (url.hostname !== "slack.com") return new Response("not found", { status: 404 });
  const method = url.pathname.replace("/api/", "");
  const text = await request.text();
  const body = (request.headers.get("content-type") ?? "").includes("json") ? JSON.parse(text || "{}") : Object.fromEntries(new URLSearchParams(text));
  if (String(body.channel ?? body.channel_id ?? "").startsWith("CRATE")) return new Response("", { status: 429, headers: { "retry-after": "7" } });
  switch (method) {
    case "users.info": {
      const id = String(body.user ?? "");
      return Response.json({ ok: true, user: { id, team_id: "T1", name: id.toLowerCase(), real_name: `Person ${id}`, profile: { email: `${id.toLowerCase()}@example.com` }, is_restricted: id.startsWith("UGUEST") } });
    }
    case "auth.test":
      return Response.json({ ok: true, url: "https://acme.slack.com/", team_id: "T1", user_id: "UBOT" });
    case "conversations.replies":
      return Response.json({ ok: true, messages: [] });
    case "conversations.info":
      return Response.json({ ok: true, channel: { id: body.channel, name: "general", is_channel: true, is_member: true } });
    case "conversations.history": {
      const all = withMetadata(history.get(body.channel) ?? [], body.include_all_metadata === "true");
      return Response.json({ ok: true, messages: all.reverse() });
    }
    case "chat.postMessage":
    case "chat.postEphemeral": {
      ts += 1;
      const posted = { ts: `${ts}.000100`, text: body.text, ...(body.metadata ? { metadata: body.metadata } : {}) };
      if (method === "chat.postMessage" && !body.thread_ts) history.set(body.channel, [...(history.get(body.channel) ?? []), posted]);
      return Response.json({ ok: true, ts: posted.ts, channel: body.channel });
    }
    default:
      return Response.json({ ok: true });
  }
}

const withMetadata = (messages, metadata) => messages.map(({ metadata: m, ...rest }) => (metadata && m ? { ...rest, metadata: m } : rest));
