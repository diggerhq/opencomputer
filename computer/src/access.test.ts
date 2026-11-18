import { describe, expect, it } from 'vitest';
import {
  ACCESS_ACTIONS,
  type Access,
  type AccessAction,
  type Actor,
  accessCommandNeeds,
  can,
  commandAction,
  decodeDrivers,
  type Drivers,
  editDrivers,
  encodeDrivers,
  gained,
  grantedText,
  joinPeople,
  normalize,
  openedText,
  overLimit,
  parseAccessCommand,
  role,
  stateText,
} from './access.js';

const OWNER = 'UOWNER01';
const LISTED = 'ULISTED1';
const MEMBER = 'UMEMBER1';
const GUEST = 'UGUEST01';
const ADMIN = 'UADMIN01';

const actors: Record<string, Actor> = {
  owner: { id: OWNER, member: true, admin: false },
  listed: { id: LISTED, member: true, admin: false },
  member: { id: MEMBER, member: true, admin: false },
  outsider: { id: GUEST, member: false, admin: false },
  admin: { id: ADMIN, member: true, admin: true },
};
const shapes: Record<string, Drivers> = { open: '*', owner: [], named: [LISTED] };

// shape, actor → role and every action it may do. The whole table of work 112's "Model".
const TABLE: [string, string, string, string][] = [
  ['open', 'owner', 'owner', 'instruct settings answer stop view grant'],
  ['open', 'listed', 'driver', 'instruct answer stop view'],
  ['open', 'member', 'driver', 'instruct answer stop view'],
  ['open', 'outsider', 'outsider', ''],
  ['open', 'admin', 'driver', 'instruct answer stop view grant'],
  ['owner', 'owner', 'owner', 'instruct settings answer stop view grant'],
  ['owner', 'listed', 'participant', 'stop view request'],
  ['owner', 'member', 'participant', 'stop view request'],
  ['owner', 'outsider', 'outsider', ''],
  ['owner', 'admin', 'participant', 'stop view request grant'],
  ['named', 'owner', 'owner', 'instruct settings answer stop view grant'],
  ['named', 'listed', 'driver', 'instruct answer stop view'],
  ['named', 'member', 'participant', 'stop view request'],
  ['named', 'outsider', 'outsider', ''],
  ['named', 'admin', 'participant', 'stop view request grant'],
];

describe('role and can', () => {
  it('match the table for 5 actors × 3 shapes × 7 actions', () => {
    expect(TABLE).toHaveLength(15);
    for (const [shape, who, r, allowed] of TABLE) {
      const a: Access = { owner: OWNER, drivers: shapes[shape]! };
      const u = actors[who]!;
      expect(role(a, u), `${shape} ${who}`).toBe(r);
      const got = ACCESS_ACTIONS.filter((act: AccessAction) => can(a, u, act)).join(' ');
      expect(got, `${shape} ${who}`).toBe(allowed);
    }
  });

  it('an admin who is not a full member cannot grant', () => {
    expect(can({ owner: OWNER, drivers: [] }, { id: ADMIN, member: false, admin: true }, 'grant')).toBe(false);
  });

  it('the owner is the owner even when not a member', () => {
    expect(role({ owner: OWNER, drivers: [] }, { id: OWNER, member: false, admin: false })).toBe('owner');
  });
});

describe('normalize', () => {
  it("keeps '*'", () => expect(normalize(OWNER, '*')).toBe('*'));
  it("drops duplicates and the owner's id, and sorts", () => {
    expect(normalize(OWNER, ['U3', 'U1', OWNER, 'U3', 'U2'])).toEqual(['U1', 'U2', 'U3']);
    expect(normalize(OWNER, [OWNER])).toEqual([]);
  });
  it('never cuts a long list: 51 stay 51, and overLimit says so', () => {
    const ids = Array.from({ length: 51 }, (_, i) => `U${String(i).padStart(7, '0')}`);
    const n = normalize(OWNER, [...ids].reverse());
    expect(n).toEqual(ids);
    expect(overLimit(n)).toBe(true);
    expect(overLimit(ids.slice(0, 50))).toBe(false);
    expect(overLimit('*')).toBe(false);
  });
});

describe('encodeDrivers / decodeDrivers', () => {
  it('round-trip each shape', () => {
    for (const d of ['*', [], ['U1', 'U2']] as Drivers[]) expect(decodeDrivers(encodeDrivers(d))).toEqual(d);
    expect(encodeDrivers('*')).toBe('*');
    expect(encodeDrivers(['U1'])).toBe('["U1"]');
  });
  it('read malformed text as [] (owner only)', () => {
    for (const t of ['', 'open', '**', '{"a":1}', '[1,2]', '["U1",2]', '"U1"', 'null', '[', null, undefined]) expect(decodeDrivers(t)).toEqual([]);
  });
});

describe('gained', () => {
  it('says what a change lets more people do', () => {
    expect(gained(['U1'], '*')).toBe('opened');
    expect(gained([], '*')).toBe('opened');
    expect(gained('*', '*')).toEqual([]);
    expect(gained('*', ['U1'])).toEqual([]);
    expect(gained(['U1', 'U2'], ['U2', 'U3', 'U4'])).toEqual(['U3', 'U4']);
    expect(gained(['U1', 'U2'], ['U1'])).toEqual([]);
  });
});

describe('commandAction', () => {
  it('classes every command of runner/commands.ts', () => {
    const expected: Record<string, string> = {
      help: 'view',
      stop: 'stop',
      esc: 'stop',
      mode: 'settings',
      model: 'instruct',
      effort: 'instruct',
      speed: 'instruct',
      status: 'view',
      diff: 'instruct',
      restart: 'settings',
      done: 'settings',
    };
    for (const [word, action] of Object.entries(expected)) expect(commandAction(`!${word} x`), word).toBe(action);
  });
  it('sends !access to the gateway, unknown words to instruct', () => {
    expect(commandAction('!access @U1234567')).toBe('access');
    expect(commandAction('!frobnicate')).toBe('instruct');
    expect(commandAction('!')).toBe('instruct');
    expect(commandAction('!toString')).toBe('instruct');
  });
  it('reads the word as the runner does: any case, after spaces', () => {
    expect(commandAction('!MODE plan')).toBe('settings');
    expect(commandAction('  ! stop')).toBe('stop');
  });
  it('is undefined for text that is not a command', () => {
    expect(commandAction('please stop')).toBeUndefined();
    expect(commandAction('!!mode plan')).toBeUndefined();
  });
});

describe('parseAccessCommand', () => {
  it('reads each form of the grammar', () => {
    expect(parseAccessCommand('!access')).toEqual({ kind: 'show' });
    expect(parseAccessCommand('!access open')).toEqual({ kind: 'set', drivers: '*' });
    expect(parseAccessCommand('!access OWNER')).toEqual({ kind: 'set', drivers: [] });
    expect(parseAccessCommand('!access @U1234567 @W7654321 @U1234567')).toEqual({ kind: 'set', drivers: ['U1234567', 'W7654321'] });
    expect(parseAccessCommand('!access add @U1234567 @U7654321')).toEqual({ kind: 'add', ids: ['U1234567', 'U7654321'] });
    expect(parseAccessCommand('!access remove @U1234567')).toEqual({ kind: 'remove', ids: ['U1234567'] });
    expect(parseAccessCommand('!access default open')).toEqual({ kind: 'default', value: 'open' });
    expect(parseAccessCommand('!access default owner')).toEqual({ kind: 'default', value: 'owner' });
  });
  it('answers any other form with usage', () => {
    for (const t of [
      '!access everyone',
      '!access open now',
      '!access add',
      '!access add bob',
      '!access @U1234567 please',
      '!access default',
      '!access default closed',
      '!access @U12',
      '!access @u1234567',
    ])
      expect(parseAccessCommand(t), t).toEqual({ kind: 'usage' });
  });
  it('says what each form needs', () => {
    expect(accessCommandNeeds({ kind: 'show' })).toBe('view');
    expect(accessCommandNeeds({ kind: 'usage' })).toBe('view');
    expect(accessCommandNeeds({ kind: 'set', drivers: '*' })).toBe('grant');
    expect(accessCommandNeeds({ kind: 'remove', ids: ['U1'] })).toBe('grant');
    expect(accessCommandNeeds({ kind: 'default', value: 'owner' })).toBe('admin');
  });
  it("edits the current list, '*' counting as empty", () => {
    expect(editDrivers('*', { kind: 'add', ids: ['U1'] })).toEqual(['U1']);
    expect(editDrivers(['U2'], { kind: 'add', ids: ['U1'] })).toEqual(['U2', 'U1']);
    expect(editDrivers(['U1', 'U2'], { kind: 'remove', ids: ['U1'] })).toEqual(['U2']);
    expect(editDrivers('*', { kind: 'remove', ids: ['U1'] })).toEqual([]);
    expect(editDrivers(['U1'], { kind: 'set', drivers: '*' })).toBe('*');
  });
});

describe('strings', () => {
  it('joinPeople', () => {
    expect(joinPeople([])).toBe('');
    expect(joinPeople(['A'])).toBe('A');
    expect(joinPeople(['A', 'B'])).toBe('A and B');
    expect(joinPeople(['A', 'B', 'C'])).toBe('A, B and C');
  });
  it('S10, each shape', () => {
    expect(stateText({ owner: 'U0', drivers: '*' })).toBe('Runs as <@U0>. Everyone in this thread can drive.');
    expect(stateText({ owner: 'U0', drivers: [] })).toBe('Runs as <@U0>. Only they can drive.');
    expect(stateText({ owner: 'U0', drivers: ['UA'] })).toBe('Runs as <@U0>. They and <@UA> can drive.');
    expect(stateText({ owner: 'U0', drivers: ['UA', 'UB'] })).toBe('Runs as <@U0>. They, <@UA> and <@UB> can drive.');
  });
  it('S3 and S3b name an admin as one', () => {
    expect(grantedText({ id: 'UB', admin: false }, ['UR'], 'U0')).toBe('<@UB> let <@UR> drive this session. It keeps running as <@U0>.');
    expect(grantedText({ id: 'UB', admin: true }, ['UR', 'US'], 'U0')).toBe(
      '<@UB> (admin) let <@UR> and <@US> drive this session. It keeps running as <@U0>.',
    );
    expect(openedText({ id: 'UB', admin: true }, 'U0')).toBe(
      '<@UB> (admin) opened this session to everyone in this thread. It keeps running as <@U0>.',
    );
  });
});
