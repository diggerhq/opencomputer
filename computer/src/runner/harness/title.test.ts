import { describe, expect, it } from 'vitest';
import { cleanTitle } from './title.js';

describe('cleanTitle', () => {
  it.each([
    ['Fix login redirect loop', 'Fix login redirect loop'],
    ['"Fix login redirect loop."', 'Fix login redirect loop'],
    ['Title: Compare hosting costs\nBecause…', 'Compare hosting costs'],
    ['**Session titles in Slack**', 'Session titles in Slack'],
    ['x'.repeat(81), ''],
  ])('%j → %j', (reply, title) => expect(cleanTitle(reply)).toBe(title));
});
