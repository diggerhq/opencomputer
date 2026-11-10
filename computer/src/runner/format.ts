// Claude Code-style one-line titles for tool calls, and result summarizing.

import path from 'node:path';
import { staleNote } from '../build.js';

const one = (s: unknown, n = 120) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/** Internal plumbing the user doesn't need to watch. */
export const HIDDEN_TOOLS = new Set(['ToolSearch']);

export function toolTitle(name: string, input: any, cwd: string): string {
  const rel = (p: unknown) => {
    const s = String(p ?? '');
    return s.startsWith(cwd) ? path.relative(cwd, s) || '.' : s;
  };
  switch (name) {
    case 'Bash':
      // Claude describes each command ("Run the tests"); that reads better than the command itself.
      if (input.description) return one(input.description, 100);
      return `Bash(${shortCommand(String(input.command ?? '').replaceAll(cwd + '/', ''))})`;
    case 'Read':
      return `Read(${rel(input.file_path)})`;
    case 'Write':
      return `Write(${rel(input.file_path)})`;
    case 'Edit':
    case 'MultiEdit':
      return `Update(${rel(input.file_path)})`;
    case 'NotebookEdit':
      return `Update(${rel(input.notebook_path)})`;
    case 'Glob':
      return `Glob(${one(input.pattern)})`;
    case 'Grep':
      return `Grep("${one(input.pattern, 60)}"${input.path ? ` in ${rel(input.path)}` : ''})`;
    case 'WebFetch':
      return `Fetch(${one(input.url)})`;
    case 'WebSearch':
      return `Search("${one(input.query)}")`;
    case 'Task':
    case 'Agent':
      return `Agent(${one(input.description ?? input.subagent_type)})`;
    case 'TodoWrite':
      return 'Update todos';
    case 'ExitPlanMode':
      return 'Plan ready';
    case 'AskUserQuestion':
      return 'Question';
    case 'mcp__calvin__send_file':
      return `Send ${path.basename(String(input.path ?? ''))}`;
    case 'mcp__calvin__spawn_thread':
      return `New thread: ${one(input.task ?? '', 100)}`;
    case 'mcp__calvin__read_thread':
      return `Read thread ${one(input.url ?? `${input.channel ?? ''} ${input.ts ?? ''}`, 100)}`;
    case 'mcp__calvin__post_thread':
      return `Post to thread ${one(input.url ?? `${input.channel ?? ''} ${input.ts ?? ''}`, 100)}`;
    case 'mcp__calvin__request_secret':
      return `Ask for $${one(input.name, 60)}`;
    default:
      // `calvin` is the internal MCP server name; Slack users know the bot as Computer.
      return `${name.replace(/^mcp__(calvin__)?/, '')}(${one(JSON.stringify(input), 80)})`;
  }
}

/** First line of a command, short: a heredoc script or long pipeline is noise in a title. */
export function shortCommand(cmd: string, n = 70): string {
  const lines = cmd.trim().split('\n');
  const first = one(lines[0], n);
  return lines.length > 1 && !first.endsWith('…') ? `${first} …` : first;
}

/** The command under a described Bash title. */
export function bashDetails(input: any, cwd: string): string | undefined {
  if (!input.description) return undefined;
  return '$ ' + one(String(input.command ?? '').replaceAll(cwd + '/', ''), 90);
}

export function editStats(name: string, input: any): string | undefined {
  const lines = (s: unknown) => (s ? String(s).split('\n').length : 0);
  if (name === 'Edit') return `+${lines(input.new_string)} −${lines(input.old_string)}`;
  if (name === 'MultiEdit')
    return `${(input.edits ?? []).length} edits`;
  if (name === 'Write') return `${lines(input.content)} lines`;
  return undefined;
}

export function todoDetails(input: any): string {
  const mark = { completed: '☑', in_progress: '◐', pending: '☐' } as Record<string, string>;
  return (input.todos ?? [])
    .map((t: any) => `${mark[t.status] ?? '☐'} ${t.status === 'in_progress' ? t.activeForm ?? t.content : t.content}`)
    .join('  ');
}

export function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map((b: any) => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[image]' : ''))
      .join('\n');
  return '';
}

/** Last few meaningful lines, like Claude Code's collapsed ⎿ output. */
export function summarizeOutput(name: string, text: string): string | undefined {
  const t = text.replace(/<\/?[a-z_-]+>/gi, '').trim();
  if (!t) return undefined;
  if (name === 'Read') return `${t.split('\n').length} lines`;
  if (name === 'Edit' || name === 'MultiEdit' || name === 'Write' || name === 'TodoWrite') return undefined;
  const lines = t.split('\n').filter((l) => l.trim());
  const tail = lines.slice(-4).join('\n');
  return lines.length > 4 ? `… +${lines.length - 4} lines\n${tail}` : tail;
}

export function fmtTokens(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function fmtDuration(ms: number) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

/** A turn's footer and `!status`: model, mode, duration, context, the thread's running cost, a stale-build note. */
export function fmtStatus(s: { model?: string; effort?: string; speed?: string; mode: string; durMs?: number; ctxTokens: number; costUsd?: number }) {
  return [
    (s.model ?? 'default').replace(/^claude-/, ''),
    s.effort, // only once `!effort` set one
    s.speed === 'standard' ? 'standard speed' : undefined, // fast, the default, goes unsaid
    s.mode !== 'bypassPermissions' ? s.mode : undefined, // as in the context bar
    s.durMs !== undefined ? fmtDuration(s.durMs) : undefined,
    s.ctxTokens ? `ctx ${fmtTokens(s.ctxTokens)}` : undefined,
    s.costUsd !== undefined ? `thread $${s.costUsd.toFixed(2)}` : undefined, // a running total: on a turn footer it read as that turn's cost
    staleNote(),
  ]
    .filter(Boolean)
    .join(' · ');
}
