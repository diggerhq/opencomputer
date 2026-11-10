import { describe, expect, it } from 'vitest';
import { CATALOG } from '../telemetry/catalog.js';
import { CLI_COMMON, CLI_EVENTS } from './cli-telemetry.js';
import { WIRE_EVENTS } from './wire-events.js';

// The catalog writes the relay's and opc's keys out, because the collector bundles it and it may import nothing
// outside src/telemetry/ (telemetry/collector/scripts/imports.mjs); this keeps the copies equal to the tables.
describe('catalog and the wire tables', () => {
  it('lists each wire.* event with exactly the relay table keys', () => {
    for (const [name, keys] of Object.entries(WIRE_EVENTS)) expect(CATALOG[name as keyof typeof CATALOG]?.data, name).toEqual(keys);
  });
  it('lists each cli.* event with the common keys and exactly its table keys', () => {
    for (const [name, keys] of Object.entries(CLI_EVENTS))
      expect(CATALOG[name as keyof typeof CATALOG]?.data, name).toEqual([...CLI_COMMON, ...keys]);
  });
});
