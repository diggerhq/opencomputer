// Encryption for what a computer's Durable Object stores: the linked Slack
// workspace's bot token and the secrets people give their sessions. AES-GCM
// like AccountDurableObject's channel credentials, from the same
// BLUE_CHANNEL_ENCRYPTION_KEY, but each use gets its own key derived with
// HKDF and a label, and the associated data names what the value is, so a
// ciphertext copied into another row or object does not decrypt.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export type SealPurpose = "slack-bot-token" | "session-secret" | "managed-model-key" | "tunnel-token" | "model-subscription";

/**
 * Derived keys, memoized per (master key, purpose) for the isolate's life
 * (work 068 §3d): importing and HKDF-deriving on every seal and unseal was on
 * every message's path. The memo holds non-extractable CryptoKeys (resolved
 * values, not promises, so nothing crosses request contexts); a rotated master
 * key is a new entry. Two first calls at once both derive, harmlessly.
 */
const derivedKeys = new Map<string, CryptoKey>();

async function derivedKey(encodedKey: string | undefined, purpose: SealPurpose): Promise<CryptoKey> {
  if (!encodedKey) throw new Error("BLUE_CHANNEL_ENCRYPTION_KEY is not configured");
  const memo = `${purpose}\0${encodedKey}`;
  const known = derivedKeys.get(memo);
  if (known) return known;
  const key = await deriveKey(encodedKey, purpose);
  derivedKeys.set(memo, key);
  return key;
}

async function deriveKey(encodedKey: string, purpose: SealPurpose): Promise<CryptoKey> {
  const raw = base64ToBytes(encodedKey);
  if (raw.byteLength !== 32) throw new Error("BLUE_CHANNEL_ENCRYPTION_KEY must contain 32 bytes");
  const base = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode("opencomputer-computer"), info: encoder.encode(`${purpose} v1`) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** `iv.ciphertext`, base64url; `context` is the associated data (who and what the value is). */
export async function seal(value: string, encodedKey: string | undefined, purpose: SealPurpose, context: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(context) },
    await derivedKey(encodedKey, purpose),
    encoder.encode(value),
  );
  return `${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(data))}`;
}

export async function unseal(sealed: string, encodedKey: string | undefined, purpose: SealPurpose, context: string): Promise<string> {
  const [iv, data] = sealed.split(".");
  if (!iv || !data) throw new Error("Malformed sealed value");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(iv), additionalData: encoder.encode(context) },
    await derivedKey(encodedKey, purpose),
    base64ToBytes(data),
  );
  return decoder.decode(plain);
}

export function randomToken(bytes = 32): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export { base64ToBytes as base64UrlToBytes, bytesToBase64Url };
