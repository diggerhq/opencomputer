// The Computer API's schema (work 084), one import for its users: objects
// (schema-objects.ts), events and deltas (schema-events.ts), and operations
// (schema-methods.ts). The source of truth for schema/computer-api.v1.json,
// which scripts/api-schema.mjs emits from `apiJsonSchema()` and `npm run check`
// diffs, and which blue copies and opc validates against.
//
// Shared by the runner and the host (both are a session's writer) and the
// relay, so it lives in src/api/ rather than src/runner/api/ (084's sketch).

import { Schema } from 'effect';
import { Delta, Event, EVENT_TYPES } from './schema-events.js';
import { CLIENT_NOTIFICATIONS, CreateSessionBody, METHODS, NOTIFICATIONS } from './schema-methods.js';
import { Actor, ApiError, Ask, Capabilities, DeclineAnswer, Person, Result, Secret, Session, Turn, TurnSummary } from './schema-objects.js';

export * from './schema-events.js';
export * from './schema-methods.js';
export * from './schema-objects.js';

export const API_SCHEMA_ID = 'https://opencomputer.dev/schemas/computer-api.v1.json';

/** The whole contract as one JSON Schema (draft 2020-12) document, deterministic. */
export function apiJsonSchema(): Record<string, unknown> {
  const methods = Object.fromEntries(Object.entries(METHODS).map(([name, m]) => [name, Schema.Struct({ params: m.params, result: m.result })]));
  const root = Schema.Struct({
    objects: Schema.Struct({ Session, Turn, TurnSummary, Ask, DeclineAnswer, Actor, Person, Capabilities, Secret, Result, Error: ApiError, Event, Delta }),
    methods: Schema.Struct(methods),
    notifications: Schema.Struct(NOTIFICATIONS),
    clientNotifications: Schema.Struct(CLIENT_NOTIFICATIONS),
    http: Schema.Struct({ createSession: CreateSessionBody }),
  });
  const doc = Schema.toJsonSchemaDocument(root) as unknown as { schema: Record<string, unknown>; definitions: Record<string, unknown> };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: API_SCHEMA_ID,
    title: 'OpenComputer Computer API v1',
    description: 'Objects, events, WebSocket methods and notifications of the Computer API. Generated from calvin src/api/schema.ts; do not edit.',
    'x-eventTypes': EVENT_TYPES,
    'x-methods': Object.fromEntries(Object.entries(METHODS).map(([name, m]) => [name, m.http])),
    ...doc.schema,
    $defs: doc.definitions,
  };
}
