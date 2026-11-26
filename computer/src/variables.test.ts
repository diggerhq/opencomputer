import { describe, expect, it } from 'vitest';
import { credentialHint, parseVariableCommand, showValue } from './variables.js';

describe('parseVariableCommand', () => {
  it('is null for anything else', () => {
    expect(parseVariableCommand('!secret X')).toBeNull();
    expect(parseVariableCommand('!variance')).toBeNull();
    expect(parseVariableCommand('set !var X 1')).toBeNull();
  });

  it('lists, helps and removes', () => {
    expect(parseVariableCommand('!vars')).toEqual({ kind: 'list' });
    expect(parseVariableCommand('!var')).toEqual({ kind: 'list' });
    expect(parseVariableCommand('!var help')).toEqual({ kind: 'help' });
    expect(parseVariableCommand('!var rm ORG')).toEqual({ kind: 'rm', name: 'ORG' });
    expect(parseVariableCommand('!var rm ORG me')).toEqual({ kind: 'rm', name: 'ORG', scope: 'user' });
    expect(parseVariableCommand('!var rm ORG there')).toMatchObject({ kind: 'bad' });
  });

  it('sets NAME value and NAME=value, with an optional trailing scope', () => {
    expect(parseVariableCommand('!var ORG acme')).toEqual({ kind: 'set', name: 'ORG', value: 'acme' });
    expect(parseVariableCommand('!var ORG=acme')).toEqual({ kind: 'set', name: 'ORG', value: 'acme' });
    expect(parseVariableCommand('!var set ORG = acme workspace')).toEqual({ kind: 'set', name: 'ORG', value: 'acme', scope: 'workspace' });
    expect(parseVariableCommand('!var GREETING hello there me')).toEqual({ kind: 'set', name: 'GREETING', value: 'hello there', scope: 'user' });
    expect(parseVariableCommand('!var URL https://a.example/x?y=1')).toEqual({ kind: 'set', name: 'URL', value: 'https://a.example/x?y=1' });
  });

  it('keeps a value in backticks exact, even one ending in a scope word', () => {
    expect(parseVariableCommand('!var WHO `just me`')).toEqual({ kind: 'set', name: 'WHO', value: 'just me' });
    expect(parseVariableCommand('!var WHO `just me` session')).toEqual({ kind: 'set', name: 'WHO', value: 'just me', scope: 'session' });
    expect(parseVariableCommand('!var CFG ```\na=1\nb=2\n```')).toEqual({ kind: 'set', name: 'CFG', value: 'a=1\nb=2' });
  });

  it('refuses bad names, reserved names and missing values', () => {
    expect(parseVariableCommand('!var 1X a')).toMatchObject({ kind: 'bad' });
    expect(parseVariableCommand('!var PATH /evil')).toMatchObject({ kind: 'bad' });
    expect(parseVariableCommand('!var ORG')).toMatchObject({ kind: 'bad' });
    expect(parseVariableCommand('!var MODE workspace')).toEqual({ kind: 'set', name: 'MODE', value: 'workspace' });
  });
});

describe('showValue', () => {
  it('shows values as one line of code', () => {
    expect(showValue('acme')).toBe('`acme`');
    expect(showValue('a\nb')).toBe('`a ⏎ b`');
    expect(showValue('a`b')).toBe('a`b');
  });
});

describe('credentialHint', () => {
  it('flags names and values that look like credentials', () => {
    for (const n of ['DEPLOY_TOKEN', 'STRIPE_KEY', 'db_password', 'AWS_SECRET_ACCESS_KEY', 'SENTRY_DSN'])
      expect(credentialHint(n, 'x')).toMatch(/sounds like a credential/);
    for (const v of [
      'sk_live_abcdefghijkl',
      'ghp_' + 'a'.repeat(36),
      'xoxb-1234-5678-abcdef',
      'AKIAABCDEFGHIJKLMNOP',
      'postgres://me:hunter2@db/x',
      '-----BEGIN OPENSSH PRIVATE KEY-----',
    ])
      expect(credentialHint('X', v)).toMatch(/looks like/);
    expect(credentialHint('X', 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3z')).toMatch(/random token/);
  });
  it('leaves ordinary values alone', () => {
    for (const [n, v] of [
      ['ORG_NAME', 'acme'],
      ['KEYBOARD', 'us'],
      ['MONKEY', 'x'],
      ['URL', 'https://a.example/x?y=1'],
      ['RUN_ID', '123e4567-e89b-12d3-a456-426614174000'],
      ['SHA', 'deadbeef'.repeat(5)],
    ])
      expect(credentialHint(n, v)).toBeUndefined();
  });
});
