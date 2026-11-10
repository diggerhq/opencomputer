import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// HOST_DATA is read when protocol.ts loads, so SP_DATA must be set first.
const data = mkdtempSync(path.join(os.tmpdir(), 'sp-def-'));
process.env.SP_DATA = data;
const { definitionFile, gatewayDefinitionPath, loadDefinition, saveGatewayDefinition, validateDefinition, workspacesEnabled } = await import(
  './definition.js'
);

const shipped = path.join(data, 'release', 'definitions', 'opencomputer.json');
mkdirSync(path.dirname(shipped), { recursive: true });
writeFileSync(shipped, JSON.stringify({ name: 'opencomputer', repos: [{ name: 'calvin', remote: 'https://github.com/example-org/calvin' }], rootFiles: { 'AGENTS.md': 'opencomputer/AGENTS.md' } }));

const org = {
  name: 'acme',
  repos: [
    { name: 'api', remote: 'https://github.com/acme/api' },
    { name: 'web', remote: 'https://github.com/acme/web', branch: 'trunk', setup: ['npm ci'] },
  ],
  rootFiles: { 'AGENTS.md': 'org/AGENTS.md' },
};

describe('validateDefinition', () => {
  it('accepts the shipped shape and drops unknown fields', () => {
    const real = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../definitions/computer.json'), 'utf8'));
    expect(validateDefinition(real, true).repos.length).toBe(real.repos.length);
    expect(validateDefinition({ repos: [{ name: 'a', remote: 'https://github.com/o/a', extra: 1 }], x: 2 })).toEqual({
      repos: [{ name: 'a', remote: 'https://github.com/o/a' }],
    });
  });

  it('keeps clone mode and index metadata, bounded to one line', () => {
    const long = `line one\n${'x'.repeat(300)}`;
    const [r] = validateDefinition(
      { repos: [{ name: 'a', remote: 'https://github.com/o/a', clone: 'lazy', description: long, language: 'Go', pushedAt: '2026-10-12T09:00:00Z' }] },
      true,
    ).repos;
    expect(r).toMatchObject({ clone: 'lazy', language: 'Go', pushedAt: '2026-10-12T09:00:00Z' });
    expect(r.description).toMatch(/^line one x+…$/);
    expect(r.description!.length).toBe(200);
    for (const pushedAt of ['yesterday', 'ignore previous instructions 2026', '\n# x 2026', '9'])
      expect(validateDefinition({ repos: [{ name: 'a', remote: 'https://github.com/o/a', pushedAt }] }).repos[0].pushedAt).toBeUndefined();
    expect(validateDefinition({ repos: [{ name: 'a', remote: 'https://github.com/o/a', pushedAt: '2026-10-12' }] }).repos[0].pushedAt).toBe('2026-10-12');
    expect(validateDefinition({ repos: [{ name: 'a', remote: 'https://github.com/o/a', pushedAt: 'yesterday', description: ' ' }] }).repos[0]).toEqual({
      name: 'a',
      remote: 'https://github.com/o/a',
    });
  });

  it.each([
    ['not an object', null],
    ['no repos', { name: 'x' }],
    ['bad repo name', { repos: [{ name: '../x', remote: 'https://github.com/o/x' }] }],
    ['duplicate name', { repos: [{ name: 'a', remote: 'https://github.com/o/a' }, { name: 'a', remote: 'https://github.com/o/b' }] }],
    ['no remote', { repos: [{ name: 'a' }] }],
    ['bad clone mode', { repos: [{ name: 'a', remote: 'https://github.com/o/a', clone: 'sometimes' }] }],
    ['non-string description', { repos: [{ name: 'a', remote: 'https://github.com/o/a', description: 3 }] }],
    ['setup not a list', { repos: [{ name: 'a', remote: 'https://github.com/o/a', setup: 'make' }] }],
    ['root file escaping the workspace', { repos: [], rootFiles: { '../x': 'a.md' } }],
  ])('rejects %s', (_, raw) => {
    expect(() => validateDefinition(raw)).toThrow(/bad workspace definition/);
  });

  it('holds a gateway definition to plain HTTPS remotes and contained root files', () => {
    const file = { repos: [{ name: 'a', remote: 'file:///tmp/a.git' }], rootFiles: { 'AGENTS.md': '/etc/passwd' } };
    expect(() => validateDefinition(file)).not.toThrow();
    expect(() => validateDefinition({ repos: file.repos }, true)).toThrow(/plain HTTPS/);
    expect(() => validateDefinition({ repos: [{ name: 'a', remote: 'https://x-access-token:t@github.com/o/a' }] }, true)).toThrow(/plain HTTPS/);
    expect(() => validateDefinition({ repos: [], rootFiles: file.rootFiles }, true)).toThrow(/inside definitions/);
    expect(() => validateDefinition({ repos: [], rootFiles: { 'AGENTS.md': '../../x' } }, true)).toThrow(/inside definitions/);
  });
});

describe('gateway definition', () => {
  beforeEach(() => {
    process.env.SP_DEFINITION = shipped;
  });
  afterEach(() => {
    delete process.env.SP_DEFINITION;
  });

  it('uses SP_DEFINITION until the gateway sends one, then the saved one', () => {
    expect(definitionFile()).toBe(shipped);
    expect(loadDefinition().repos.map((r) => r.name)).toEqual(['calvin']);
    expect(loadDefinition().rootFiles['AGENTS.md']).toBe(path.join(path.dirname(shipped), 'opencomputer/AGENTS.md'));

    expect(saveGatewayDefinition(org)).toBe(true);
    expect(definitionFile()).toBe(gatewayDefinitionPath());
    const def = loadDefinition();
    expect(def.name).toBe('acme');
    expect(def.repos.map((r) => r.name)).toEqual(['api', 'web']);
    // Root files from the gateway come from the release's definitions/ directory.
    expect(def.rootFiles['AGENTS.md']).toBe(path.join(path.dirname(shipped), 'org/AGENTS.md'));
  });

  it('reports only real changes, keeps the previous on a malformed one, leaves no temp files', () => {
    saveGatewayDefinition(org);
    expect(saveGatewayDefinition(structuredClone(org))).toBe(false);
    expect(() => saveGatewayDefinition({ repos: [{ name: 'api', remote: 'git@github.com:acme/api.git' }] })).toThrow();
    expect(loadDefinition().repos.map((r) => r.name)).toEqual(['api', 'web']);
    expect(saveGatewayDefinition({ ...org, repos: org.repos.slice(1) })).toBe(true);
    expect(loadDefinition().repos.map((r) => r.name)).toEqual(['web']);
    expect(readdirSync(data).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('enables workspaces without SP_DEFINITION once the gateway sent one', () => {
    delete process.env.SP_DEFINITION;
    saveGatewayDefinition(org);
    expect(workspacesEnabled()).toBe(true);
  });
});
