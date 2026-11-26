import { describe, expect, it } from 'vitest';
import { CATALOG } from './catalog.js';
import { eventLine, SCHEMA_VERSION, tbTime, uuidv7 } from './envelope.js';
import { checkEvent, checkTurn } from './validate.js';

const at = tbTime(Date.UTC(2026, 9, 12, 10, 0, 0, 123));
const event = (over: Record<string, unknown> = {}) => ({
  schema_version: SCHEMA_VERSION,
  event_id: uuidv7(),
  event_name: 'fork.repo',
  occurred_at: at,
  service_name: 'host',
  service_version: 'abc123',
  region: 'westus2',
  synthetic: false,
  data: { repo: 'opencomputer', fetch_ms: 120 },
  ...over,
});
const turn = (over: Record<string, unknown> = {}) => ({
  schema_version: SCHEMA_VERSION,
  turn_id: uuidv7(),
  trace_id: uuidv7(),
  session_key: 'T1:C1:1791837260.198489',
  sent_at: at,
  region: 'westus2',
  synthetic: false,
  outcome: 'completed',
  first_visible_ms: 1800,
  ...over,
});

describe('checkEvent', () => {
  it('passes a well-formed event and copies it', () => {
    const input = event();
    const c = checkEvent(input);
    expect(c.ok).toBe(true);
    if (c.ok) {
      expect(c.value).toEqual(input);
      expect(c.value).not.toBe(input);
      expect(c.clamped).toBe(false);
    }
  });

  it.each([
    ['an unknown field', { prompt: 'hi' }],
    ['a non-scalar data value', { data: { repo: ['a'] } }],
    ['a value outside a closed list', { error_type: 'segfault' }],
    ['an outcome outside the closed list', { outcome: 'exploded' }],
    ['a free-form error code', { error_code: 'Error: ENOENT, open /etc/passwd' }],
    ['an oversized field', { tool_name: 'x'.repeat(257) }],
    ['a Slack token', { data: { repo: 'xoxb-1234-5678' } }],
    ['an API key', { error_code: 'sk-ant-api03-abcdefgh' }],
    ['a GitHub token', { conversation_id: 'ghs_abcdefghijklmnopqrstuvwx' }],
    ['an OpenComputer API key', { conversation_id: 'osb_abcdefghijklmnopqrstuvwx' }],
    ['an Authorization header', { data: { repo: 'Bearer abc' } }],
    ['a filesystem path', { data: { repo: '/data/people/owner/ws/secret' } }],
    ['a URL', { surface_workspace_id: 'https://github.com/acme/api' }],
    ['multi-line text', { data: { repo: 'line one\nline two' } }],
    ['a bad timestamp', { occurred_at: '2026-10-12T10:00:00Z' }],
    ['a missing required field', { region: undefined }],
    ['a wrong schema version', { schema_version: 2 }],
    ['an infinite duration', { duration_ms: Number.POSITIVE_INFINITY }],
  ])('drops %s', (_, over) => {
    expect(checkEvent(event(over)).ok).toBe(false);
  });

  it.each([
    ['an event the catalog does not know', { event_name: 'render.started' }],
    ['a data key the catalog does not list', { data: { repo: 'x', kind: 'browser' } }],
    ['an event from another service', { service_name: 'runner' }],
  ])('passes %s: names are not checked, shapes are', (_, over) => {
    expect(checkEvent(event(over)).ok).toBe(true);
  });

  it('allows / only in model and service_version', () => {
    expect(checkEvent(event({ model: 'meta/muse-wonder-1.0', service_version: 'v1/abc' })).ok).toBe(true);
  });

  it('clamps a negative duration to 0 and says so', () => {
    const c = checkEvent(event({ duration_ms: -12 }));
    expect(c.ok && c.value.duration_ms === 0 && c.clamped).toBe(true);
  });

  it('accepts every catalog event with its own keys', () => {
    for (const [name, spec] of Object.entries(CATALOG)) {
      const data = Object.fromEntries(spec.data.map((k) => [k, 1]));
      expect(checkEvent(event({ event_name: name, service_name: spec.service, data })).ok, name).toBe(true);
    }
  });

  it('serializes data as a JSON string for Tinybird', () => {
    const line = JSON.parse(eventLine(event() as never));
    expect(typeof line.data).toBe('string');
    expect(JSON.parse(line.data)).toEqual({ repo: 'opencomputer', fetch_ms: 120 });
  });
});

describe('checkTurn', () => {
  it('fills absent milestones with null and counters with 0', () => {
    const c = checkTurn(turn({ outcome: 'silent', first_visible_ms: undefined }));
    expect(c.ok).toBe(true);
    if (c.ok) {
      expect(c.value.first_visible_ms).toBeNull();
      expect(c.value.renderable_ms).toBeNull();
      expect(c.value.tool_calls).toBe(0);
    }
  });

  it.each([
    ['an unknown column', { prompt_text: 'hi' }],
    ['a non-turn outcome', { outcome: 'abandoned' }],
    ['a fractional counter', { tool_calls: 1.5 }],
    ['a missing trace', { trace_id: undefined }],
    ['a path in an id', { conversation_id: 'C1/../../etc' }],
  ])('drops %s', (_, over) => {
    expect(checkTurn(turn(over)).ok).toBe(false);
  });

  it('clamps a negative offset', () => {
    const c = checkTurn(turn({ received_ms: -40 }));
    expect(c.ok && c.value.received_ms === 0 && c.clamped).toBe(true);
  });
});

describe('uuidv7', () => {
  it('is a version-7 UUID that sorts by time', () => {
    const a = uuidv7(1_000);
    const b = uuidv7(2_000);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });
});
