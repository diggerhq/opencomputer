import { describe, expect, it } from 'vitest';
import type { RepoDef } from './definition.js';
import { INDEX_HEADING, repoIndex } from './repo-index.js';

const repo = (name: string, extra: Partial<RepoDef> = {}): RepoDef => ({ name, remote: `https://github.com/acme/${name}`, ...extra });

describe('repoIndex', () => {
  it('is omitted when every published repository is checked out', () => {
    expect(repoIndex([repo('api'), repo('ghost', { unpublished: true })], new Set(['api']))).toBeUndefined();
    expect(repoIndex([], new Set())).toBeUndefined();
  });

  it('lists checked-out repositories first, then by last push, with metadata', () => {
    const md = repoIndex(
      [
        repo('old', { pushedAt: '2025-01-01T00:00:00Z' }),
        repo('web', { pushedAt: '2026-10-12T00:00:00Z', language: 'TypeScript', description: 'The | site' }),
        repo('api', { pushedAt: '2024-01-01T00:00:00Z' }),
      ],
      new Set(['api']),
    )!;
    expect(md.startsWith(INDEX_HEADING)).toBe(true);
    expect(md).toContain('3 repositories are available');
    expect(md).toContain('`checkout_repo`');
    const rows = md.split('\n').filter((l) => l.startsWith('| `'));
    expect(rows).toEqual([
      '| `api` (acme/api) | yes | pushed 2024-01-01 |',
      '| `web` (acme/web) | — | TypeScript · The / site · pushed 2026-10-12 |',
      '| `old` (acme/old) | — | pushed 2025-01-01 |',
    ]);
  });

  it('names the repositories beyond the limit on one line', () => {
    const md = repoIndex(['a', 'b', 'c', 'd'].map((n) => repo(n)), new Set(), 2)!;
    expect(md.split('\n').filter((l) => l.startsWith('| `'))).toHaveLength(2);
    expect(md).toContain('Also available: `c`, `d`.');
  });
});
