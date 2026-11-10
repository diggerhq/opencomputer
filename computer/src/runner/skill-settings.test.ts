import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HIDDEN_SKILLS, hideBundledSkills, mergedSettings } from './skill-settings.js';

const fork = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'skill-settings-'));
  writeFileSync(path.join(dir, '.fork.json'), '{}');
  return dir;
};
const settingsOf = (dir: string) => readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8');

describe('hideBundledSkills', () => {
  it('writes the same bytes in every workspace fork, and again on a restart', () => {
    const a = fork();
    const b = fork();
    expect(hideBundledSkills(a)).toBe(true);
    hideBundledSkills(b);
    hideBundledSkills(a);
    expect(settingsOf(a)).toBe(settingsOf(b));
    const overrides = JSON.parse(settingsOf(a)).skillOverrides;
    for (const name of Object.keys(HIDDEN_SKILLS)) expect(overrides[name]).toBe('off');
  });

  it('leaves a folder that is not a workspace fork alone', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'skill-settings-'));
    expect(hideBundledSkills(dir)).toBe(false);
    expect(() => settingsOf(dir)).toThrow();
  });

  it('merges into settings already there, keeping their keys and their own choices', () => {
    const dir = fork();
    mkdirSync(path.join(dir, '.claude'));
    writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, skillOverrides: { loop: 'on', mine: 'off' } }));
    hideBundledSkills(dir);
    const s = JSON.parse(settingsOf(dir));
    expect(s.permissions).toEqual({ allow: ['Bash(ls)'] });
    expect(s.skillOverrides.loop).toBe('on');
    expect(s.skillOverrides.mine).toBe('off');
    expect(s.skillOverrides['keybindings-help']).toBe('off');
  });
});

describe('mergedSettings', () => {
  it('leaves a file that is not a JSON object untouched', () => {
    expect(mergedSettings('{ not json')).toBeUndefined();
    expect(mergedSettings('[]')).toBeUndefined();
    expect(mergedSettings('{"skillOverrides": []}')).toBeUndefined();
  });

  it('keeps the bytes of a file that already hides them all', () => {
    const once = mergedSettings(undefined)!;
    const theirs = once.replace(/\n/g, '\r\n');
    expect(mergedSettings(theirs)).toBe(theirs);
  });
});
