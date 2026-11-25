// The world a webhook is sent into, faked: DNS over HTTPS, and endpoints on `*.hooks.test`.
// `fail-<n>.hooks.test` answers 500 to its first n requests, then 200. `GET https://hooks.test/calls`
// answers what every endpoint received; `DELETE` forgets it.
let calls = [];

export async function fakeDeliveryOutbound(request) {
  const url = new URL(request.url);
  if (url.hostname === "cloudflare-dns.com") {
    const name = url.searchParams.get("name");
    const type = url.searchParams.get("type");
    if (type !== "A") return Response.json({ Answer: [] });
    const data = name === "private.hooks.test" ? "10.0.0.7" : name === "metadata.hooks.test" ? "169.254.169.254" : "93.184.216.34";
    return Response.json({ Answer: [{ type: 1, data }] });
  }
  if (url.hostname === "hooks.test") {
    if (request.method === "DELETE") calls = [];
    return Response.json(calls);
  }
  if (url.hostname.endsWith(".hooks.test")) {
    const host = url.hostname;
    const seen = calls.filter((call) => call.host === host).length;
    const failures = Number(/^fail-(\d+)\./.exec(host)?.[1] ?? 0);
    const status = host.startsWith("redirect.") ? 302 : seen < failures ? 500 : 200;
    calls.push({
      host,
      path: url.pathname,
      status,
      occurrence: request.headers.get("oc-occurrence"),
      timestamp: request.headers.get("oc-timestamp"),
      signature: request.headers.get("oc-signature"),
      body: await request.text(),
    });
    return new Response(null, { status, headers: status === 302 ? { location: "https://ok.hooks.test/elsewhere" } : {} });
  }
  return new Response("no such host", { status: 502 });
}
