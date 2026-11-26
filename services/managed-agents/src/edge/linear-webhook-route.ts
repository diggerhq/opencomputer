// `POST /v1/webhooks/linear/:connectionId/:token` (work 037 Routes; design
// 018 "Ingress, acceptance and acknowledgement").
//
// The shape is the generic webhook ingress's (verify, claim durably, answer),
// not Slack's respond-then-`waitUntil` (gap L1): the Account object writes the
// ledger row before this handler answers, so a 200 means the delivery is
// stored. Linear wants an answer within five seconds; acceptance does no
// provider or session work, which the Account alarm enacts.

import type { AccountDurableObject } from "./account-do.js";
import { json, problem, readBoundedText } from "./http.js";
import { LINEAR_WEBHOOK_BODY_LIMIT } from "./linear-ingress.js";
import { LINEAR_DELIVERY_HEADER, LINEAR_SIGNATURE_HEADER } from "../channels/linear.js";
import { resolveLinearWebhookRoute } from "./linear-connections.js";

export const LINEAR_WEBHOOK_PATTERN = /^\/v1\/webhooks\/linear\/([^/]+)\/([^/]+)$/;

export interface LinearWebhookRouteEnv {
  ACCOUNTS: DurableObjectNamespace<AccountDurableObject>;
}

export async function receiveLinearWebhook(
  request: Request,
  env: LinearWebhookRouteEnv,
  connectionId: string,
  token: string,
): Promise<Response> {
  // Malformed ids and tokens are refused before any object is touched; the
  // token's hash is compared in constant time against the route object.
  const route = await resolveLinearWebhookRoute(env.ACCOUNTS, connectionId, token);
  if (!route) {
    console.warn(
      JSON.stringify({ level: "warn", event: "linear.webhook_route_rejected", connectionId }),
    );
    return problem(401, "invalid_webhook_token", "Invalid webhook token");
  }
  const payload = await readBoundedText(request, LINEAR_WEBHOOK_BODY_LIMIT);
  if (payload === null) {
    return problem(413, "payload_too_large", "Webhook body is too large");
  }
  const result = await env.ACCOUNTS.getByName(route.accountId).receiveLinearWebhook({
    connectionId: route.connectionId,
    accountId: route.accountId,
    edgeOrigin: new URL(request.url).origin,
    deliveryId: request.headers.get(LINEAR_DELIVERY_HEADER),
    signature: request.headers.get(LINEAR_SIGNATURE_HEADER),
    payload,
  });
  if (result.status === 200) return json(result.body, 200);
  const code = result.body.error ?? "rejected";
  return problem(result.status, code, "Linear delivery rejected");
}
