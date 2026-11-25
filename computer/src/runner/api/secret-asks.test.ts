// Secret requests share the journal with questions; values never enter asks.
import { describe, expect, it } from 'vitest';
import { Asks } from './asks.js';
import type { Ask } from '../../api/schema-objects.js';

describe('secret asks', () => {
  it('stays open until its named secret arrives and the agent resumes; journals no value', () => {
    const events: Ask[] = [];
    const asks = new Asks({
      sessionId: 'cs_test', turnId: () => 'tn_test',
      record: (_type, ask) => events.push(structuredClone(ask)),
      actorOf: (id) => ({ id, name: id, via: 'api', client: null }),
      changed: () => {},
    });
    const handle = asks.open({ kind: 'secret', secret: { name: 'TOKEN', purpose: 'Call the API', file: false } }, () => {});
    expect(events[0]).toMatchObject({ kind: 'secret', status: 'open', secret: { name: 'TOKEN' } });
    const actor = { id: 'usr_owner', name: 'Owner', via: 'dashboard' as const, client: null };
    asks.secretsSet(['OTHER']);
    asks.closeReadySecrets(actor);
    expect(asks.openIds()).toEqual([handle.id]);
    asks.secretsSet(['TOKEN']);
    expect(asks.openIds()).toEqual([handle.id]);
    asks.closeReadySecrets(actor);
    asks.closeReadySecrets(actor);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ status: 'answered', answer: null });
    expect(asks.openIds()).toEqual([]);
    expect(JSON.stringify(events)).not.toContain('value');
  });
});
