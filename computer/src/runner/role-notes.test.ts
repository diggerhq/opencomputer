import { describe, expect, it } from 'vitest';
import { APP_NOTE, TRACK_NOTE, prefaced } from './role-notes.js';
import type { Work, WorkSession } from './work.js';

const work = (s: WorkSession): Work => ({ api: { call: async () => ({}) } as never, session: () => s });

describe('prefaced', () => {
  it('leaves a Slack session and a runner with no cloud as they are', () => {
    expect(prefaced(undefined, 'hi')).toBe('hi');
    expect(prefaced(work({ id: 'cs_1', slackThread: 'T1:C1:1.2' }), 'hi')).toBe('hi');
  });
  it('puts the app note before a session with no Slack surface, the track note before a track session', () => {
    expect(prefaced(work({ id: 'cs_1' }), 'hi')).toBe(`${APP_NOTE}\n\nhi`);
    expect(prefaced(work({ id: 'cs_1', role: { name: 'track', trackId: 'trk_1' }, slackThread: 'T1:C1:1.2' }), 'hi')).toBe(`${TRACK_NOTE}\n\nhi`);
  });
});
