import { describe, expect, it } from 'vitest';
import { LateNotes } from './late-notes.js';

describe('LateNotes', () => {
  it('steers a note into a running turn; with none running, holds it for the next message', () => {
    let busy = true;
    const steered: string[] = [];
    const notes = new LateNotes(() => busy, (n) => steered.push(n));
    notes.add('[a is now at /a]');
    expect(steered).toEqual(['[a is now at /a]']);
    busy = false;
    notes.add('[b is now at /b]');
    notes.add('[c could not be downloaded]');
    expect(steered).toHaveLength(1);
    expect(notes.with('hello')).toBe('hello\n[b is now at /b]\n[c could not be downloaded]');
    // Told once.
    expect(notes.with('again')).toBe('again');
    expect(notes.with('')).toBe('');
  });
});
