// Store.syncPeople: SP_PEOPLE is the allowlist, so on start someone no longer
// listed loses their people row, while their sessions stay.

import { describe, expect, it } from 'vitest';
import type { SlackPerson } from '../protocol.js';
import { Store } from './db.js';

const person = (id: string, name = id): SlackPerson => ({ slackUserId: id, dir: id.toLowerCase(), gitName: name, gitEmail: `${id}@example.com` });

describe('syncPeople', () => {
  it('upserts the listed people and removes everyone else', () => {
    const store = new Store(':memory:');
    store.putPerson(person('U1'));
    store.putPerson(person('U2'));
    expect(store.syncPeople([person('U1', 'Renamed'), person('U3')])).toEqual(['U2']);
    expect(store.person('U2')).toBeUndefined();
    expect(store.person('U1')?.gitName).toBe('Renamed');
    expect(store.people().map((p) => p.slackUserId).sort()).toEqual(['U1', 'U3']);
  });

  it("keeps a removed person's sessions", () => {
    const store = new Store(':memory:');
    const owner = person('U2');
    store.putPerson(owner);
    const spec = { key: 'C1:1.1', kind: 'thread', channel: 'C1', threadTs: '1.1', owner, teamId: 'T1', title: 't', mode: 'default' } as const;
    store.putSession(spec);
    store.syncPeople([person('U1')]);
    expect(store.person('U2')).toBeUndefined();
    expect(store.session(spec.key)?.spec.owner.slackUserId).toBe('U2');
  });
});
