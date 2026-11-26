/**
 * One-hour OpenComputer keys for an organization's computer
 * (work 067). A session's `opencomputer` CLI asks the host's token socket, the
 * host asks this gateway (`{t:"token", kind:"opencomputer"}`), and the gateway
 * asks the public edge to mint an org key that expires in an hour, so no
 * long-lived key lives on the VM. Signed like `requestManagedModelKey`.
 */
import { hmacSha256Hex } from "../../../../edge/runtime-usage.js";
import type { ProvisionEnv } from "../model-access/model-key.js";
import { isSessionId } from "../../../../ids/session-ids.js";

export const COMPUTER_KEYS_PATH = "/internal/computer-keys";
const MINT_TIMEOUT_MS = 10_000;

export interface OpenComputerKey {
  token: string;
  expiresAt: string;
  /** Where the key works: the CLI's `OPENCOMPUTER_API_URL`. */
  apiUrl: string;
}

/**
 * `sessionId` is the `cs_…` session of this organization the gateway found for
 * the asking runner: the edge stores it on the key, which makes the key that
 * session's agent (spec 34.3). Without one nothing is minted: a key with no
 * session would reach the whole organization.
 */
export async function mintOpenComputerKey(
  env: ProvisionEnv,
  organizationId: string,
  sessionId: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<OpenComputerKey> {
  if (!isSessionId(sessionId)) throw new Error("OpenComputer keys are minted for a session only");
  if (!env.OPENCOMPUTER_APP_URL || !env.OC_MANAGED_CRED_HMAC_SECRET) throw new Error("OpenComputer keys are not configured on this gateway");
  const body = JSON.stringify({ org_id: organizationId, session_key: sessionId });
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const signature = await hmacSha256Hex(env.OC_MANAGED_CRED_HMAC_SECRET, `${timestamp}.${body}`);
  const response = await fetcher(new URL(COMPUTER_KEYS_PATH, env.OPENCOMPUTER_APP_URL), {
    method: "POST",
    headers: { "content-type": "application/json", "X-Timestamp": timestamp, "X-Signature": signature },
    body,
    signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    throw new Error(`OpenComputer key request failed (${response.status}): ${detail}`);
  }
  const minted = (await response.json()) as { key?: string; expiresAt?: string };
  if (!minted.key || !minted.expiresAt) throw new Error("OpenComputer key request returned no key");
  return { token: minted.key, expiresAt: minted.expiresAt, apiUrl: new URL(env.OPENCOMPUTER_APP_URL).origin };
}
