// What the collector does to a host batch before Tinybird sees it (work 054,
// "Pipeline", collector → Tinybird): overwrite identity from the credential,
// re-validate every record against the shared catalog, replace repository
// names with a keyed digest, and add one `telemetry.batch` record so lost
// batches show as gaps in `batch_seq`.
//
// Invariants: identity comes only from the credential, never from the body;
// a record that fails validation is dropped whole and counted, never
// forwarded partly; no raw `repo` value leaves this function.

import { SCHEMA_VERSION, type TelemetryEvent, type TurnRow, tbTime, uuidv7 } from '../../../src/telemetry/envelope.js';
import { checkEvent, checkTurn } from '../../../src/telemetry/validate.js';
import type { Credential } from './credential.js';

/** The body a host POSTs to `/v1/events`. */
export interface HostBatch {
  host_boot_id: string;
  batch_seq: number;
  events: unknown[];
  turns: unknown[];
}

export interface Processed {
  events: TelemetryEvent[];
  turns: TurnRow[];
  invalid: number;
  clamped: number;
}

export interface Stamp {
  version: string;
  region: string;
  now: number;
}

/** Event `data` keys holding a repository name, which is customer data. */
const REPO_KEYS = ['repo'];
const BOOT_ID = /^[A-Za-z0-9-]{1,64}$/;
export const MAX_RECORDS = 1000;

/** The batch's shape, or why it is not one (a 400: the host drops it). */
export function parseBatch(body: unknown): HostBatch | string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'body: not an object';
  const b = body as Record<string, unknown>;
  if (typeof b.host_boot_id !== 'string' || !BOOT_ID.test(b.host_boot_id)) return 'host_boot_id: missing or malformed';
  if (typeof b.batch_seq !== 'number' || !Number.isSafeInteger(b.batch_seq) || b.batch_seq < 0) return 'batch_seq: not a sequence number';
  const events = b.events ?? [];
  const turns = b.turns ?? [];
  if (!Array.isArray(events) || !Array.isArray(turns)) return 'events, turns: not arrays';
  if (events.length + turns.length > MAX_RECORDS) return `more than ${MAX_RECORDS} records`;
  return { host_boot_id: b.host_boot_id, batch_seq: b.batch_seq, events, turns };
}

/** HMAC-SHA256 under `REPO_DIGEST_KEY`, first 12 hex: stable per name, not reversible without the key. */
export async function digest(key: CryptoKey, value: string): Promise<string> {
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
  return Array.from(mac.slice(0, 6), (x) => x.toString(16).padStart(2, '0')).join('');
}

export const digestKey = (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);

const stamped = (input: unknown, who: Credential): unknown =>
  typeof input === 'object' && input !== null && !Array.isArray(input) ? { ...input, org_id: who.org_id, host_id: who.host_id } : input;
/** Only the collector writes `service_name: collector` rows; a host sending one could fake `batch_seq` and hide gaps. */
const posesAsCollector = (input: unknown): boolean => (input as { service_name?: unknown } | null)?.service_name === 'collector';

/** Validate, stamp and digest a host batch; never throws on record content. */
export async function processBatch(batch: HostBatch, who: Credential, repoKey: CryptoKey, at: Stamp): Promise<Processed> {
  const out: Processed = { events: [], turns: [], invalid: 0, clamped: 0 };
  for (const input of batch.events) {
    const r = checkEvent(stamped(input, who));
    if (!r.ok || posesAsCollector(input)) {
      out.invalid++;
      continue;
    }
    if (r.clamped) out.clamped++;
    const e = r.value;
    for (const k of REPO_KEYS) if (typeof e.data[k] === 'string') e.data[k] = await digest(repoKey, e.data[k] as string);
    out.events.push(e);
  }
  for (const input of batch.turns) {
    const r = checkTurn(stamped(input, who));
    if (!r.ok) {
      out.invalid++;
      continue;
    }
    if (r.clamped) out.clamped++;
    out.turns.push(r.value);
  }
  const own = (event_name: 'telemetry.batch' | 'telemetry.dropped', data: TelemetryEvent['data']): TelemetryEvent => ({
    schema_version: SCHEMA_VERSION,
    event_id: uuidv7(at.now),
    event_name,
    occurred_at: tbTime(at.now),
    service_name: 'collector',
    service_version: at.version,
    region: at.region,
    synthetic: false,
    org_id: who.org_id,
    host_id: who.host_id,
    data,
  });
  out.events.push(
    own('telemetry.batch', {
      host_boot_id: batch.host_boot_id,
      batch_seq: batch.batch_seq,
      events: out.events.length,
      turns: out.turns.length,
      dropped: out.invalid,
    }),
  );
  if (out.invalid) out.events.push(own('telemetry.dropped', { reason: 'invalid', count: out.invalid }));
  if (out.clamped) out.events.push(own('telemetry.dropped', { reason: 'clock', count: out.clamped }));
  return out;
}
