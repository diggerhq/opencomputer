// Session roles (work 112): who may drive a Slack session. A session stores
// its `owner` (never changes) and `drivers`, `'*'` or a list of Slack user
// ids; every role is computed from these on each event and stored nowhere.
//
//   owner        started the session; it runs as them
//   driver       anyone when drivers is '*', else the listed ids
//   participant  a full member who is not a driver: their messages are context
//   outsider     not a full member (guest, another organization, a bot)
//
// An org admin is a flag on a person, not a role: they may replace `drivers`
// on any session and nothing else. The gateway decides every Slack event with
// `can`; the runner learns the sender's role from `Delivery.role` only to know
// who may answer a prompt.
//
// Pure: no I/O, no Slack client, no SQL. Byte-identical in calvin
// (computer/src/access.ts) and in managed-agents (src/computer/access.ts);
// change both together. Block Kit views are in access-views.ts.

export type Drivers = '*' | readonly string[];
export type Role = 'owner' | 'driver' | 'participant' | 'outsider';
export interface Access {
  /** Slack user id. */
  owner: string;
  drivers: Drivers;
}
/** Whoever acts. `member`: a full member of the workspace (each gateway's own check); `admin`: an org admin. */
export interface Actor {
  id: string;
  member: boolean;
  admin: boolean;
}
export type AccessAction = 'instruct' | 'settings' | 'answer' | 'stop' | 'view' | 'request' | 'grant';
/** Who changed `drivers`: `admin` only when an admin who is not the owner did. */
export interface ChangedBy {
  id: string;
  admin: boolean;
}
/** The organization's default for new sessions (setting `accessDefault`). */
export type AccessDefault = 'open' | 'owner';

export const ACCESS_ACTIONS: readonly AccessAction[] = ['instruct', 'settings', 'answer', 'stop', 'view', 'request', 'grant'];
/** The settings key of the organization's default. */
export const ACCESS_DEFAULT_SETTING = 'accessDefault';
/** The most people `drivers` may name; a longer list is refused where it is entered, never cut. */
export const MAX_DRIVERS = 50;
/** Held context: text cut to this when stored, the newest rows read, rows older than this deleted. */
export const CONTEXT_MAX_CHARS = 4_000;
export const CONTEXT_MAX_ROWS = 40;
export const CONTEXT_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
/** The `!help` line. */
export const ACCESS_HELP_LINE = '`!access`: who can drive this session';

/** First match wins: the owner, then anyone not a full member, then the drivers. */
export function role(a: Access, u: Actor): Role {
  if (u.id === a.owner) return 'owner';
  if (!u.member) return 'outsider';
  if (a.drivers === '*' || a.drivers.includes(u.id)) return 'driver';
  return 'participant';
}

const ALLOWED: Record<Role, readonly AccessAction[]> = {
  owner: ['instruct', 'settings', 'answer', 'stop', 'view', 'grant'],
  driver: ['instruct', 'answer', 'stop', 'view'],
  participant: ['stop', 'view', 'request'],
  outsider: [],
};

/** Whether `u` may do `action` in the session. A member admin may always `grant`. */
export function can(a: Access, u: Actor, action: AccessAction): boolean {
  if (action === 'grant' && u.admin && u.member) return true;
  return ALLOWED[role(a, u)].includes(action);
}

/** Restricted: not everyone in the thread drives. Decides only the 🔒 marker. */
export function restricted(d: Drivers): boolean {
  return d !== '*';
}

/** The stored form of `drivers`: `'*'` stays; a list loses duplicates and the owner's id, sorted. Never cut. */
export function normalize(owner: string, next: Drivers): Drivers {
  if (next === '*') return '*';
  return [...new Set(next)].filter((id) => id !== owner).sort();
}

/** Whether a list is longer than `MAX_DRIVERS` (`tooManyPeople()` is the refusal). */
export function overLimit(d: Drivers): boolean {
  return d !== '*' && d.length > MAX_DRIVERS;
}

export function sameDrivers(a: Drivers, b: Drivers): boolean {
  if (a === '*' || b === '*') return a === b;
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** The column's text: `'*'` or a JSON array of ids. */
export function encodeDrivers(d: Drivers): string {
  return d === '*' ? '*' : JSON.stringify(d);
}

/** The column read back; anything that is neither `'*'` nor a JSON array of strings is `[]` (owner only). */
export function decodeDrivers(text: string | null | undefined): Drivers {
  if (text === '*') return '*';
  try {
    const v: unknown = JSON.parse(text ?? '');
    return Array.isArray(v) && v.every((id) => typeof id === 'string') ? v : [];
  } catch {
    return [];
  }
}

/** The setting read back: absent or any other value is `open`. */
export function readAccessDefault(value: string | null | undefined): AccessDefault {
  return value === 'owner' ? 'owner' : 'open';
}

/** A new (not spawned) session's `drivers` under the organization's default. */
export function initialDrivers(d: AccessDefault): Drivers {
  return d === 'owner' ? [] : '*';
}

/**
 * Who can drive after a change that more people than before can: `'opened'`
 * (a list became `'*'`), or the ids added to a list. `[]` when the change only
 * narrows (or `'*'` stays `'*'`), which is announced nowhere.
 */
export function gained(prev: Drivers, next: Drivers): 'opened' | string[] {
  if (next === '*') return prev === '*' ? [] : 'opened';
  if (prev === '*') return [];
  return next.filter((id) => !prev.includes(id));
}

// ---------------------------------------------------------------- commands

/**
 * What a `!command` needs. `'access'`: `!access`, handled by the gateway and
 * never delivered. Undefined: not a command (no `!`, or `!!`). Gateway
 * commands (`!secret`, `!var`, ...) are checked before this and keep their own
 * rules; here they would read as `instruct`.
 */
export type CommandClass = AccessAction | 'access';

const COMMANDS: Record<string, CommandClass> = {
  stop: 'stop',
  esc: 'stop',
  help: 'view',
  status: 'view',
  mode: 'settings',
  restart: 'settings',
  done: 'settings',
  access: 'access',
};

/** The first word after `!`, lower-cased, as the runner reads it; undefined when `text` is not a command. */
export function commandWord(text: string): string | undefined {
  const t = text.trim();
  if (!t.startsWith('!') || t.startsWith('!!')) return undefined;
  return (t.slice(1).trim().split(/\s+/)[0] ?? '').toLowerCase();
}

export function commandAction(text: string): CommandClass | undefined {
  const word = commandWord(text);
  if (word === undefined) return undefined;
  return Object.hasOwn(COMMANDS, word) ? COMMANDS[word] : 'instruct';
}

/** `!access …` as typed (decoded text, with the `!access` word). */
export type AccessCommand =
  | { kind: 'show' }
  /** `open` → `'*'`, `owner` → `[]`, `@a @b` → those ids (not yet normalized). */
  | { kind: 'set'; drivers: Drivers }
  | { kind: 'add'; ids: string[] }
  | { kind: 'remove'; ids: string[] }
  | { kind: 'default'; value: AccessDefault }
  | { kind: 'usage' };

const MENTION = /@([UW][A-Z0-9]{6,})/g;
const MENTION_ONLY = /^@[UW][A-Z0-9]{6,}$/;

/** Slack user ids mentioned in decoded text, in order, de-duplicated. */
export function mentionedIds(text: string): string[] {
  return [...new Set([...text.matchAll(MENTION)].map((m) => m[1] ?? ''))];
}

export function parseAccessCommand(text: string): AccessCommand {
  const [word, ...args] = text.trim().slice(1).trim().split(/\s+/);
  if (word?.toLowerCase() !== 'access') return { kind: 'usage' };
  const [first = '', second = '', ...more] = args.map((a) => a.toLowerCase());
  if (!first) return { kind: 'show' };
  if (args.length === 1 && first === 'open') return { kind: 'set', drivers: '*' };
  if (args.length === 1 && first === 'owner') return { kind: 'set', drivers: [] };
  if (first === 'default' && !more.length && (second === 'open' || second === 'owner')) return { kind: 'default', value: second };
  const people = (tokens: string[]) => (tokens.length && tokens.every((t) => MENTION_ONLY.test(t)) ? mentionedIds(tokens.join(' ')) : undefined);
  if (first === 'add' || first === 'remove') {
    const ids = people(args.slice(1));
    return ids ? { kind: first, ids } : { kind: 'usage' };
  }
  const ids = people(args);
  return ids ? { kind: 'set', drivers: ids } : { kind: 'usage' };
}

/** What a parsed `!access` needs: `view`, `grant`, or `admin` (an admin who is a full member). */
export function accessCommandNeeds(c: AccessCommand): 'view' | 'grant' | 'admin' {
  if (c.kind === 'show' || c.kind === 'usage') return 'view';
  return c.kind === 'default' ? 'admin' : 'grant';
}

/**
 * The list a `set`, `add` or `remove` asks for, from the current one. Not normalized. `undefined` when the session is
 * open and the edit is `add` or `remove`: there is no list to change, and making one would lock the thread by surprise.
 */
export function editDrivers(current: Drivers, c: Extract<AccessCommand, { kind: 'set' | 'add' | 'remove' }>): Drivers | undefined {
  if (c.kind === 'set') return c.drivers;
  if (current === '*') return undefined;
  return c.kind === 'add' ? [...current, ...c.ids] : current.filter((id) => !c.ids.includes(id));
}

/** The answer to any other form of `!access`. */
export const ACCESS_USAGE = [
  '`!access`: who can drive this session',
  '`!access open`: everyone in this thread can drive',
  '`!access owner`: only the owner can drive',
  '`!access @a @b`: the owner and these people can drive',
  '`!access add @a @b` / `!access remove @a`: change who is named',
].join('\n');

// ---------------------------------------------------------------- strings

export const mention = (id: string) => `<@${id}>`;

/** `A`, `A and B`, `A, B and C`. */
export function joinPeople(names: readonly string[]): string {
  if (names.length < 2) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

const byLine = (by: ChangedBy) => `${mention(by.id)}${by.admin ? ' (admin)' : ''}`;

/** S1, the request in the thread. */
export const requestText = (owner: string, requester: string) => `${mention(owner)}, ${mention(requester)} wants to drive this session.`;
/** S2, ephemeral to the requester. */
export const requestSentText = (owner: string) =>
  `${mention(owner)} decides who can drive this session and has been asked. Your message runs if they allow it.`;
/** S2b, ephemeral: a participant's later mention. */
export const ownerDecidesText = (owner: string) => `${mention(owner)} decides who can drive this session.`;
/** S3b, in the thread: a list became `'*'`. */
export const openedText = (by: ChangedBy, owner: string) =>
  `${byLine(by)} opened this session to everyone in this thread. It keeps running as ${mention(owner)}.`;
/** S3, in the thread: these people were added. */
export const grantedText = (by: ChangedBy, people: readonly string[], owner: string) =>
  `${byLine(by)} let ${joinPeople(people.map(mention))} drive this session. It keeps running as ${mention(owner)}.`;
/** S4, the declined request (a context block). */
export const declinedText = (requester: string) => `${mention(requester)} asked to drive · not now`;
/** S5, ephemeral: a wrong clicker on a request. */
export const onlyGrantorAnswersText = (owner: string) => `Only ${mention(owner)} or an admin can answer this.`;
/** S6, ephemeral: a wrong clicker on a prompt. */
export const notAskedText = (owner: string) => `This is waiting on someone else. Only they or ${mention(owner)} can answer it.`;
/** S7, ephemeral: a `settings` command from someone else; `word` as `commandWord` reads it. */
export const ownerCommandText = (owner: string, word: string) => `Only ${mention(owner)} can use \`!${word}\` in this session.`;
/** S8, ephemeral: any other command from someone who cannot instruct. */
export const driversCommandText = (word: string) => `Only people who can drive this session can use \`!${word}\`.`;
/** S9, in the thread: someone other than the owner stopped the turn. */
export const stoppedText = (user: string) => `:octagonal_sign: ${mention(user)} stopped the turn.`;

/** S10, the state line. */
export function stateText(a: Access): string {
  const who =
    a.drivers === '*'
      ? 'Everyone in this thread can drive.'
      : a.drivers.length
        ? `${joinPeople(['They', ...a.drivers.map(mention)])} can drive.`
        : 'Only they can drive.';
  return `Runs as ${mention(a.owner)}. ${who}`;
}

/** S11, ephemeral or modal error. */
export const onlyGrantorChangesText = (owner: string) => `Only ${mention(owner)} or an admin can change who drives this session.`;
/** S12, ephemeral. */
export const noSessionText = () => 'There is no session in this thread.';
/** S13, ephemeral. */
export const defaultChangedText = (d: AccessDefault) =>
  d === 'open' ? 'New sessions now start open to everyone in their thread.' : 'New sessions now start with only their owner driving.';
/** S14, ephemeral: production's answer to an outsider's mention. */
export const onlyMembersText = () => 'Only full members of this workspace can drive sessions.';
/** S15, ephemeral. */
export const onlyAdminDefaultText = () => 'Only an admin can change the default.';

/** A list longer than `MAX_DRIVERS`, where it is entered. */
export const tooManyPeopleText = () => `At most ${MAX_DRIVERS} people can be named.`;
/** Modal error on `people`: "Specific people" with nobody left once the owner is taken out. */
export const pickSomeoneText = () => 'Pick at least one person, or choose “Only me”.';
/** Modal error on `people`, and `!access`'s answer: a named id that is not a full member. */
export const notMemberText = (name: string) => `${name} can’t be added: only full members of this workspace can drive.`;
