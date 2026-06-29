// Operator helper: enable Managed model billing for one org by calling the edge's
// POST /internal/model-billing/enable (token-billing §5.1). Signs the CF_ADMIN_SECRET
// HMAC for you. Use it to provision a dev/test org so "Managed" resolves in the UI.
//
//   CF_ADMIN_SECRET=… node enable-model-billing.mjs \
//       --edge https://opencomputer-edge-prod.<acct>.workers.dev \
//       --org <org_id> [--disable]
//
// Prereqs on the edge: OPENROUTER_PROVISIONING_KEY + OC_MANAGED_CRED_HMAC_SECRET set;
// the matching OC_MANAGED_CRED_HMAC_SECRET set on sessions-api. The edge mints the
// org's OpenRouter key and binds it to sessions-api as a managed credential, then
// flips orgs.model_billing_status='active' (→ /billing.managedAvailable=true).

import { createHmac } from "node:crypto";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1]?.startsWith("--") || arr[i + 1] === undefined ? "true" : arr[i + 1]]);
    return acc;
  }, []),
);

const edge = (args.edge || process.env.EDGE_URL || "").replace(/\/+$/, "");
const org = args.org || process.env.ORG_ID;
const secret = process.env.CF_ADMIN_SECRET;
const op = args.disable === "true" ? "disable" : "enable";

if (!edge || !org || !secret) {
  console.error("usage: CF_ADMIN_SECRET=… node enable-model-billing.mjs --edge <url> --org <org_id> [--disable]");
  process.exit(1);
}

const body = JSON.stringify({ org_id: org });
const ts = Math.floor(Date.now() / 1000).toString();
const sig = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");

const res = await fetch(`${edge}/internal/model-billing/${op}`, {
  method: "POST",
  headers: { "content-type": "application/json", "X-Timestamp": ts, "X-Signature": sig },
  body,
});
const text = await res.text();
console.log(`${op} → HTTP ${res.status}: ${text}`);
process.exit(res.ok ? 0 : 1);
