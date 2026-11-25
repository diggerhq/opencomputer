// The edge's credential check, faked: the credential `cred_revoked` is revoked, the token
// `renewed` verifies as the same principal with a later expiry, `other` as another subject.
export async function fakeLiveEdge(request) {
  if (request.headers.get("authorization") !== "Bearer test-live-key") return new Response("no", { status: 401 });
  const body = await request.json();
  if (Array.isArray(body.check)) return Response.json({ revoked: body.check.filter((id) => id === "cred_revoked") });
  const principal = (subject) => ({
    org: "org_a",
    subject,
    kind: "member",
    via: "app",
    scopes: ["sessions:read", "work:read"],
    audiences: ["org"],
    admin: false,
    credential: { id: "cred_renewed", expiresAt: null },
  });
  if (body.token === "renewed") return Response.json({ principal: principal("user_1") });
  if (body.token === "other") return Response.json({ principal: principal("user_2") });
  return Response.json({ principal: null });
}
