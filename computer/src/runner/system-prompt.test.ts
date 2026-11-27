import { describe, expect, it } from 'vitest';
import { drivenFrom, PROMPTS, systemAppend } from './system-prompt.js';

describe('systemAppend', () => {
  it('tells a session where it is driven from, and never the other place', () => {
    expect(systemAppend('slack')).toContain('You are being driven from Slack, not a terminal.');
    expect(systemAppend('app')).toContain('You are being driven from the Computer app');
    expect(systemAppend('app')).not.toContain('driven from Slack');
    expect(systemAppend()).toBe(systemAppend('slack')); // a spare is prewarmed before its session is known
    expect(systemAppend(drivenFrom(false))).toBe(systemAppend('app'));
  });

  it('teaches the app session the app, not Slack: no message labels of Slack, no mrkdwn, no notifying mentions', () => {
    const app = systemAppend('app');
    for (const slackOnly of ['[Slack: from', 'Slack mrkdwn', 'To notify someone', '<!here>']) expect(app).not.toContain(slackOnly);
    expect(app).toContain('[App: from Sam]');
  });

  it('lists every variant for the leak guard', () => {
    expect([...PROMPTS].sort()).toEqual([systemAppend('app'), systemAppend('slack')].sort());
  });
});
