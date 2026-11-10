import { describe, expect, it } from 'vitest';
import { ReminderFilter } from './stream.js';

describe('ReminderFilter', () => {
  it('passes plain text through', () => {
    const f = new ReminderFilter();
    expect(f.push('hello ') + f.push('world') + f.flush()).toBe('hello world');
  });

  it('drops a reminder that arrives in one delta', () => {
    const f = new ReminderFilter();
    expect(f.push('a<system-reminder>secret</system-reminder>b') + f.flush()).toBe('ab');
  });

  it('drops a reminder split across deltas', () => {
    const f = new ReminderFilter();
    const out = ['a<system-', 'reminder>sec', 'ret</system-rem', 'inder>b'].map((d) => f.push(d)).join('') + f.flush();
    expect(out).toBe('ab');
  });

  it('holds back a possible partial tag and releases it when it was not one', () => {
    const f = new ReminderFilter();
    expect(f.push('x <sys')).toBe('x ');
    expect(f.push('tem is fine')).toBe('<system is fine');
    expect(f.flush()).toBe('');
  });

  it('flush inside an unterminated reminder emits nothing and resets', () => {
    const f = new ReminderFilter();
    expect(f.push('a<system-reminder>never closed')).toBe('a');
    expect(f.flush()).toBe('');
    expect(f.push('b') + f.flush()).toBe('b');
  });
});
