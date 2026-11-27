import { describe, expect, it } from 'vitest';
import { APP_NOTE } from '../role-notes.js';
import { cleanTitle, conversation } from './title.js';

describe('cleanTitle', () => {
  it.each([
    ['Fix login redirect loop', 'Fix login redirect loop'],
    ['"Fix login redirect loop."', 'Fix login redirect loop'],
    ['Title: Compare hosting costs\nBecause…', 'Compare hosting costs'],
    ['**Session titles in Slack**', 'Session titles in Slack'],
    ['x'.repeat(81), ''],
  ])('%j → %j', (reply, title) => expect(cleanTitle(reply)).toBe(title));
});

describe('conversation', () => {
  it('leaves out the setup around a person\'s message, so the namer reads the task', () => {
    const first = `${APP_NOTE}\n\n[Slack: from Sam (<@U1>) in #eng, mentions you]\n<system-reminder>\nRepositories…\n</system-reminder>\nFix the login redirect loop`;
    expect(conversation([{ person: true, text: first }, { person: false, text: '[Not a note] On it.' }])).toEqual({
      said: 1,
      text: 'Person: Fix the login redirect loop\n\nAgent: [Not a note] On it.',
    });
  });
});
