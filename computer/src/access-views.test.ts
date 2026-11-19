import type { KnownBlock, View } from '@slack/types';
import { describe, expect, it } from 'vitest';
import type { Access, Actor } from './access.js';
import {
  accessButtonBlock,
  accessView,
  decodeAccessId,
  declinedPost,
  grantorView,
  readOnlyView,
  readSubmission,
  requestPost,
  statePost,
  submittedKey,
} from './access-views.js';

const KEY = 'C0B:1791495325.000001';
const owner: Actor = { id: 'UOWNER01', member: true, admin: false };
const admin: Actor = { id: 'UADMIN01', member: true, admin: true };
const member: Actor = { id: 'UMEMBER1', member: true, admin: false };
const guest: Actor = { id: 'UGUEST01', member: false, admin: false };
const named: Access = { owner: owner.id, drivers: ['UA000001', 'UB000001'] };

describe('Block Kit shapes', () => {
  it('are what Bolt accepts as blocks and views', () => {
    // A compile-time check: tsc fails here if a builder drifts from Slack's types.
    const blocks: KnownBlock[] = [
      ...requestPost(KEY, 'U0', 'U1').blocks,
      ...declinedPost('U1').blocks,
      accessButtonBlock(KEY),
      ...statePost(KEY, named, true).blocks,
    ];
    const views: View[] = [grantorView(KEY, named, false), readOnlyView(named)];
    expect(blocks.length + views.length).toBe(8);
  });
});

describe('messages', () => {
  it('the request: S1 with Allow and Not now for the requester', () => {
    const p = requestPost(KEY, 'U0', 'U1');
    expect(p.text).toBe('<@U0>, <@U1> wants to drive this session.');
    const actions = p.blocks[1];
    if (actions?.type !== 'actions') throw new Error('no actions block');
    expect(actions.elements.map((b) => [b.text.text, b.style, decodeAccessId(b.action_id)])).toEqual([
      ['Allow', 'primary', { sessionKey: KEY, verb: 'allow', userId: 'U1' }],
      ['Not now', undefined, { sessionKey: KEY, verb: 'deny', userId: 'U1' }],
    ]);
  });
  it('a declined request is one context block with S4', () => {
    expect(declinedPost('U1')).toEqual({
      text: '<@U1> asked to drive · not now',
      blocks: [{ type: 'context', elements: [{ type: 'mrkdwn', text: '<@U1> asked to drive · not now' }] }],
    });
  });
  it('the Access button is exactly the spec’s block', () => {
    expect(accessButtonBlock(KEY)).toEqual({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Access' },
          action_id: `ac:${Buffer.from(KEY).toString('base64url')}:open`,
          value: 'open',
        },
      ],
    });
  });
  it('!access: S10, and Change… only for a grantor', () => {
    expect(statePost(KEY, named, false).blocks).toHaveLength(1);
    const p = statePost(KEY, named, true);
    expect(p.text).toBe('Runs as <@UOWNER01>. They, <@UA000001> and <@UB000001> can drive.');
    const b = p.blocks[1];
    if (b?.type !== 'actions') throw new Error('no button');
    expect(b.elements[0]?.text.text).toBe('Change…');
    expect(decodeAccessId(b.elements[0]!.action_id)).toEqual({ sessionKey: KEY, verb: 'open' });
  });
});

describe('the modal', () => {
  const radio = (v: ReturnType<typeof grantorView>) => {
    const b = v.blocks[1];
    if (b?.type !== 'input' || b.element.type !== 'radio_buttons') throw new Error('no radio');
    return b.element;
  };
  const users = (v: ReturnType<typeof grantorView>) => {
    const b = v.blocks[2];
    if (b?.type !== 'input' || b.element.type !== 'multi_users_select') throw new Error('no picker');
    return b.element;
  };

  it('starts on the current value', () => {
    expect(radio(grantorView(KEY, { owner: 'U0', drivers: '*' }, false)).initial_option?.value).toBe('open');
    expect(radio(grantorView(KEY, { owner: 'U0', drivers: [] }, false)).initial_option?.value).toBe('owner');
    expect(radio(grantorView(KEY, named, false)).initial_option?.value).toBe('people');
    expect(users(grantorView(KEY, named, false)).initial_users).toEqual(['UA000001', 'UB000001']);
    expect(users(grantorView(KEY, { owner: 'U0', drivers: [] }, false)).initial_users).toBeUndefined();
  });
  it('says Only the owner to an admin who is not the owner', () => {
    expect(radio(grantorView(KEY, named, false)).options.map((o) => o.text.text)).toEqual(['Everyone in this thread', 'Only me', 'Specific people']);
    expect(radio(grantorView(KEY, named, true)).options[1]?.text.text).toBe('Only the owner');
  });
  it('carries the session key, and its title, buttons and first line', () => {
    const v = grantorView(KEY, named, false);
    expect(submittedKey(v)).toBe(KEY);
    expect([v.callback_id, v.title.text, v.submit?.text, v.close.text]).toEqual(['access', 'Session access', 'Save', 'Cancel']);
    expect(v.blocks[0]).toEqual({
      type: 'section',
      text: { type: 'mrkdwn', text: 'This session runs as <@UOWNER01>: their repositories, secrets and credentials.' },
    });
  });
  it('picks the view by role', () => {
    expect(accessView(KEY, named, owner)?.submit?.text).toBe('Save');
    expect(radio(accessView(KEY, named, admin)!).options[1]?.text.text).toBe('Only the owner');
    const ro = accessView(KEY, named, member)!;
    expect([ro.submit, ro.close.text, ro.blocks]).toEqual([
      undefined,
      'Close',
      [{ type: 'section', text: { type: 'mrkdwn', text: 'Runs as <@UOWNER01>. They, <@UA000001> and <@UB000001> can drive.' } }],
    ]);
    expect(accessView(KEY, named, guest)).toBeUndefined();
  });
});

describe('readSubmission', () => {
  const submit = (who: string, picked: string[] = []) => ({
    private_metadata: JSON.stringify({ key: KEY }),
    state: { values: { who: { v: { selected_option: { value: who } } }, people: { v: { selected_users: picked } } } },
  });
  it('reads each choice', () => {
    expect(readSubmission(submit('open', ['UA000001']), named, owner)).toEqual({ ok: true, drivers: '*', ids: [] });
    expect(readSubmission(submit('owner'), named, owner)).toEqual({ ok: true, drivers: [], ids: [] });
    expect(readSubmission(submit('people', ['UZ000001', owner.id, 'UA000001']), named, admin)).toEqual({
      ok: true,
      drivers: ['UA000001', 'UZ000001'],
      ids: ['UA000001', 'UZ000001'],
    });
  });
  it('refuses nobody left, too many, and someone who cannot grant', () => {
    expect(readSubmission(submit('people', [owner.id]), named, owner)).toEqual({
      ok: false,
      errors: { people: 'Pick at least one person, or choose “Only me”.' },
    });
    const many = Array.from({ length: 51 }, (_, i) => `U${String(i).padStart(7, '0')}`);
    expect(readSubmission(submit('people', many), named, owner)).toEqual({ ok: false, errors: { people: 'At most 50 people can be named.' } });
    expect(readSubmission(submit('open'), named, member)).toEqual({
      ok: false,
      errors: { who: 'Only <@UOWNER01> or an admin can change who drives this session.' },
    });
  });
  it('reads no key from bad metadata', () => {
    expect(submittedKey({ private_metadata: 'x' })).toBeUndefined();
    expect(submittedKey({})).toBeUndefined();
  });
});
