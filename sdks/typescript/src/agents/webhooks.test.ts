import { describe, it, expect } from "vitest";
import { verifyWebhook, WebhookVerificationError } from "./webhooks.js";

const SECRET = "whsec_" + btoa("super-secret-key-bytes-123456");

async function sign(id: string, ts: number, body: string, secret: string): Promise<string> {
  const keyB64 = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const bin = atob(keyB64);
  const keyBytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) keyBytes[i] = bin.charCodeAt(i);
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${body}`)));
  let b = "";
  for (let i = 0; i < mac.length; i++) b += String.fromCharCode(mac[i]);
  return "v1," + btoa(b);
}

describe("verifyWebhook", () => {
  const id = "msg_1";
  const ts = 1_700_000_000;
  const body = JSON.stringify({
    type: "turn.completed", sessionId: "ses_1", eventId: "msg_1",
    metadata: { pull_number: 7 }, event: { id: "evt_1", type: "turn.completed" },
  });
  const hdr = (sig: string) => ({ "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": sig });

  it("accepts a valid signature and returns the parsed envelope (metadata verbatim)", async () => {
    const delivery = await verifyWebhook(body, hdr(await sign(id, ts, body, SECRET)), SECRET, { nowSeconds: ts });
    expect(delivery.type).toBe("turn.completed");
    expect(delivery.eventId).toBe("msg_1");
    expect(delivery.metadata).toEqual({ pull_number: 7 });
  });

  it("rejects a tampered body", async () => {
    const sig = await sign(id, ts, body, SECRET);
    await expect(verifyWebhook(body + " ", hdr(sig), SECRET, { nowSeconds: ts })).rejects.toThrow(WebhookVerificationError);
  });

  it("rejects an out-of-tolerance timestamp (replay)", async () => {
    const sig = await sign(id, ts, body, SECRET);
    await expect(verifyWebhook(body, hdr(sig), SECRET, { nowSeconds: ts + 10_000 })).rejects.toThrow(/tolerance/);
  });

  it("rejects a wrong secret", async () => {
    const sig = await sign(id, ts, body, SECRET);
    const wrong = "whsec_" + btoa("different-key-bytes-000000");
    await expect(verifyWebhook(body, hdr(sig), wrong, { nowSeconds: ts })).rejects.toThrow(WebhookVerificationError);
  });

  it("accepts when one of several rotated signatures matches", async () => {
    const good = await sign(id, ts, body, SECRET);
    const delivery = await verifyWebhook(body, hdr(`v1,bogus ${good}`), SECRET, { nowSeconds: ts });
    expect(delivery.sessionId).toBe("ses_1");
  });

  it("throws on missing headers", async () => {
    await expect(verifyWebhook(body, {}, SECRET, { nowSeconds: ts })).rejects.toThrow(/missing/);
  });
});
