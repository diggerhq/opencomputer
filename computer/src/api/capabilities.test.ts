import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { capabilities } from './capabilities.js';
import { Capabilities } from './schema-objects.js';

// schema/capabilities.v1.json is the published list: blue vendors it and tests its HTTP copy against the same file
// (review r2 P2-5), so the attach result and GET /capabilities cannot drift apart unnoticed.
const FIXTURE = path.resolve(import.meta.dirname, '../../schema/capabilities.v1.json');

describe('capabilities', () => {
  it('equals the published fixture', () => {
    expect(capabilities()).toEqual(JSON.parse(readFileSync(FIXTURE, 'utf8')));
  });

  it('is a valid Capabilities object with exactly one default model', () => {
    const c = Schema.decodeUnknownSync(Capabilities)(capabilities());
    expect(c.models.filter((m) => m.default)).toHaveLength(1);
  });
});
