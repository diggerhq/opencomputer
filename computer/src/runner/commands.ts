// `!` commands typed in the thread: the terminal's keyboard shortcuts and
// status line. Each one answers in the thread; a command that throws is
// reported there too (session.ts), otherwise the gateway would say it could
// not reach the session.

import type { PermissionMode } from '../protocol.js';
import type { Harness } from './harness/types.js';
import { bootCommit, latestRelease, staleNote } from '../build.js';
import { gitDiff } from '../workspace.js';
import { helpText } from './help.js';
import { switchEffort, switchModel, switchSpeed } from './model-switch.js';
import type { SessionHooks, SessionInfo } from './session.js';
import type { Surface } from './api/surface.js';

export const MODE_ALIASES: Record<string, PermissionMode> = {
  default: 'default',
  ask: 'default',
  accept: 'acceptEdits',
  acceptedits: 'acceptEdits',
  edits: 'acceptEdits',
  plan: 'plan',
  auto: 'auto',
  bypass: 'bypassPermissions',
  yolo: 'bypassPermissions',
};

/** What a command needs from the session it runs in. */
export interface CommandHost {
  info: SessionInfo;
  hooks: SessionHooks;
  thread: Surface;
  isBusy: boolean;
  threadId: string;
  model: string;
  say(text: string): Promise<void>;
  interrupt(): Promise<void>;
  setMode(mode: PermissionMode): Promise<void>;
  updateContextBar(): Promise<void>;
  ensureHarness(): Harness;
  persist(): void;
  statusLine(): string;
}

export async function runCommand(s: CommandHost, cmd: string | undefined, arg: string) {
  switch (cmd?.toLowerCase()) {
    case 'help':
      return s.say(helpText(s.model, s.info.mode));
    case 'stop':
    case 'esc':
      return s.interrupt();
    case 'mode': {
      const mode = MODE_ALIASES[arg.toLowerCase()];
      if (!mode) return s.say(`modes: ${Object.keys(MODE_ALIASES).join(', ')}`);
      await s.setMode(mode);
      return s.say(`mode → \`${mode}\``);
    }
    case 'model':
      return switchModel(s, arg);
    case 'effort':
      return switchEffort(s, arg);
    case 'speed':
      return switchSpeed(s, arg);
    case 'status':
      return s.say(
        s.statusLine() +
          `\nthread \`${s.threadId}\` · cwd \`${s.info.cwd}\` · session \`${s.info.sdkSessionId ?? '-'}\` · bot \`${bootCommit ?? '?'}\`` +
          (staleNote() ? ` (${staleNote()})` : ''),
      );
    case 'diff': {
      const d = await gitDiff(s.info.cwd);
      if (!d) return s.say('no changes');
      if (s.info.kind === 'channel') await s.thread.setDiffView(d);
      return s.say('```\n' + d.slice(0, 11000) + '\n```');
    }
    case 'restart':
      return restart(s);
    case 'done':
      if (s.info.kind !== 'channel') return s.say('`!done` archives a code channel; this is a thread');
      await s.thread.archive();
      return;
    default:
      return s.say(`unknown command \`!${cmd ?? ''}\`, try \`!help\``);
  }
}

async function restart(s: CommandHost) {
  if (!s.hooks.restart) return s.say('`!restart` works on a hosted runner; here, restart the process');
  const latest = latestRelease();
  // Restart even on the newest version: a new agent process also starts from a clean environment.
  const to = latest && latest !== bootCommit ? ` → \`${latest}\`` : '';
  await s.say(
    s.isBusy
      ? `restarting \`${bootCommit ?? '?'}\`${to} when this turn ends (\`!stop\` to end it now); the conversation carries over`
      : `restarting \`${bootCommit ?? '?'}\`${to}; your next message starts the new version and the conversation carries over`,
  );
  s.hooks.restart();
}
