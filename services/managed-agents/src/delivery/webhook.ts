// A webhook's delivery (tracks and threads, spec section 40.6): the request, its signature, and
// the refusal of an address that is not public.

import { SEND_TIMEOUT_MS } from "./contract.js";

const encoder = new TextEncoder();

/** `v1=<hex HMAC-SHA256 of timestamp.body>`. */
export async function sign(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${body}`)));
  return `v1=${[...mac].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** The reason an endpoint's URL is refused, or null: `https:` on port 443, no credentials. */
export function urlRefusal(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return "The URL does not parse.";
  }
  if (url.protocol !== "https:") return "The URL must be https.";
  if (url.port !== "" && url.port !== "443") return "The URL must be on port 443.";
  if (url.username || url.password) return "The URL must not carry credentials.";
  if (text.length > 2_048) return "The URL is too long.";
  return null;
}

function privateV4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

/** Private, loopback, link-local, unspecified or otherwise not a public unicast address. */
export function privateAddress(address: string): boolean {
  const text = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (!text.includes(":")) return privateV4(text);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (mapped) return privateV4(mapped[1]!);
  if (text === "::" || text === "::1") return true;
  // Unique local fc00::/7, link-local fe80::/10, multicast ff00::/8, mapped and translated forms.
  return /^(f[cd]|fe[89ab]|ff)/.test(text) || text.startsWith("::ffff:") || text.startsWith("64:ff9b:");
}

/** The host's addresses, asked at each delivery. A name with none is not delivered to. */
async function resolve(host: string): Promise<string[]> {
  if (/^[\d.]+$/.test(host) || host.includes(":")) return [host];
  const ask = async (type: "A" | "AAAA"): Promise<string[]> => {
    const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`The host's address could not be asked (${response.status}).`);
    const answer = (await response.json()) as { Answer?: { type: number; data: string }[] };
    return (answer.Answer ?? []).filter((record) => record.type === (type === "A" ? 1 : 28)).map((record) => record.data);
  };
  return (await Promise.all([ask("A"), ask("AAAA")])).flat();
}

/** One delivery. Resolves on a 2xx; throws on anything else, which the owed call retries. */
export async function post(endpoint: { url: string; secret: string }, key: string, body: string, now: number): Promise<void> {
  const refusal = urlRefusal(endpoint.url);
  if (refusal) throw new Error(refusal);
  const addresses = await resolve(new URL(endpoint.url).hostname);
  if (addresses.length === 0) throw new Error("The host has no address.");
  if (addresses.some(privateAddress)) throw new Error("The host resolves to an address that is not public.");
  const timestamp = String(Math.floor(now / 1_000));
  const response = await fetch(endpoint.url, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/json",
      "user-agent": "OpenComputer-Webhooks/1",
      "oc-occurrence": key,
      "oc-timestamp": timestamp,
      "oc-signature": await sign(endpoint.secret, timestamp, body),
    },
    body,
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  await response.body?.cancel().catch(() => undefined);
  if (response.status < 200 || response.status > 299) throw new Error(`The endpoint answered ${response.status}.`);
}
