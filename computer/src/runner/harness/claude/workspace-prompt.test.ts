import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { INDEX_HEADING } from '../../../workspaces/repo-index.js';
import { SUBAGENT_MAX, subagentSection, subagentWorkspaceHook, workspacePrompt } from './workspace-prompt.js';

const AGENTS = `# Your organization's computer\n\nSay who asked in pull request bodies.\n\n${INDEX_HEADING}\n\n| Repository | Here | About |\n|---|---|---|\n| \`alpha\` | yes | x |\n`;

function folder(files: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ws-prompt-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
  return dir;
}

describe('workspacePrompt', () => {
  it('moves a fork AGENTS.md into the system prompt and excludes the file', () => {
    const dir = folder({ 'AGENTS.md': AGENTS, '.fork.json': '{}' });
    const ws = workspacePrompt(dir)!;
    expect(ws.append).toContain('# Workspace instructions');
    expect(ws.append).toContain('Say who asked in pull request bodies.');
    expect(ws.append).toContain('| `alpha` | yes | x |');
    expect(ws.exclude).toEqual([path.join(dir, 'AGENTS.md')]);
  });

  it('names nothing of the session, so two forks of one workspace get the same text', () => {
    const a = workspacePrompt(folder({ 'AGENTS.md': AGENTS, '.fork.json': '{"key":"a"}' }))!;
    const b = workspacePrompt(folder({ 'AGENTS.md': AGENTS, '.fork.json': '{"key":"b"}' }))!;
    expect(a.append).toBe(b.append);
    expect(a.subagent).toBe(b.subagent);
  });

  it('leaves any other folder to Claude Code', () => {
    expect(workspacePrompt(folder({ 'AGENTS.md': AGENTS }))).toBeUndefined();
    expect(workspacePrompt(folder({ '.fork.json': '{}' }))).toBeUndefined();
    expect(workspacePrompt(folder({ 'AGENTS.md': '  \n', '.fork.json': '{}' }))).toBeUndefined();
    expect(workspacePrompt('/nonexistent/folder')).toBeUndefined();
  });
});

describe('subagentSection', () => {
  it('drops the repository index and says where it is', () => {
    const s = subagentSection(AGENTS);
    expect(s).toContain('Say who asked in pull request bodies.');
    expect(s).not.toContain('| `alpha`');
    expect(s).toContain('Repositories in this workspace');
  });

  it('points to the file when even that is too long for hook context', () => {
    const s = subagentSection('x '.repeat(SUBAGENT_MAX));
    expect(s.length).toBeLessThan(SUBAGENT_MAX);
    expect(s).toContain('AGENTS.md');
  });
});

describe('subagentWorkspaceHook', () => {
  const run = (cwd: string, agent_type: string) =>
    subagentWorkspaceHook().hooks[0](
      { hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type, cwd, session_id: 's', transcript_path: '' } as never,
      undefined,
      {
        signal: new AbortController().signal,
      },
    );

  it('hands a subagent the instructions, by the cwd it reports', async () => {
    const dir = folder({ 'AGENTS.md': AGENTS, '.fork.json': '{}' });
    const out = (await run(dir, 'general-purpose')) as { hookSpecificOutput?: { additionalContext?: string } };
    expect(out.hookSpecificOutput?.additionalContext).toContain('Say who asked in pull request bodies.');
  });

  it('gives Explore and Plan nothing, as Claude Code gives them no instruction files', async () => {
    const dir = folder({ 'AGENTS.md': AGENTS, '.fork.json': '{}' });
    expect(await run(dir, 'Explore')).toEqual({});
    expect(await run(folder({}), 'general-purpose')).toEqual({});
  });
});
