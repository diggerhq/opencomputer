import { describe, expect, it } from 'vitest';
import { bashDetails, editStats, fmtDuration, fmtTokens, summarizeOutput, todoDetails, toolTitle } from './format.js';

const cwd = '/work/repo';

describe('toolTitle', () => {
  it('prefers the model’s description for Bash and shows the command as details', () => {
    const input = { command: 'npm test -- auth', description: 'Run the auth tests' };
    expect(toolTitle('Bash', input, cwd)).toBe('Run the auth tests');
    expect(bashDetails(input, cwd)).toBe('$ npm test -- auth');
  });

  it('shows the command when there is no description, with the cwd stripped', () => {
    expect(toolTitle('Bash', { command: `cat ${cwd}/a.txt` }, cwd)).toBe('Bash(cat a.txt)');
    expect(toolTitle('Bash', { command: "python3 - <<'EOF'\nprint(1)\nEOF" }, cwd)).toBe("Bash(python3 - <<'EOF' …)");
    expect(toolTitle('Bash', { command: 'x'.repeat(200) }, cwd).length).toBeLessThan(80);
    expect(bashDetails({ command: 'ls' }, cwd)).toBeUndefined();
  });

  it('shows file tools with paths relative to the workspace', () => {
    expect(toolTitle('Read', { file_path: `${cwd}/src/a.ts` }, cwd)).toBe('Read(src/a.ts)');
    expect(toolTitle('Edit', { file_path: `${cwd}/src/a.ts` }, cwd)).toBe('Update(src/a.ts)');
    expect(toolTitle('Read', { file_path: '/elsewhere/x' }, cwd)).toBe('Read(/elsewhere/x)');
  });

  it('names the in-process tools by what they do, never showing the internal server name', () => {
    expect(toolTitle('mcp__calvin__send_file', { path: '/tmp/x/chart.png' }, cwd)).toBe('Send chart.png');
    expect(toolTitle('mcp__calvin__spawn_thread', { task: 'Review the PR' }, cwd)).toBe('New thread: Review the PR');
    expect(toolTitle('mcp__calvin__request_secret', { name: 'API_KEY', reason: 'x' }, cwd)).toBe('Ask for $API_KEY');
    expect(toolTitle('mcp__calvin__future_tool', { a: 1 }, cwd)).toBe('future_tool({"a":1})');
  });

  it('falls back to name(json) for unknown tools, without the mcp__ prefix', () => {
    expect(toolTitle('mcp__x__y', { a: 1 }, cwd)).toBe('x__y({"a":1})');
  });

  it('truncates long titles with an ellipsis', () => {
    const t = toolTitle('Glob', { pattern: 'x'.repeat(200) }, cwd);
    expect(t.length).toBeLessThanOrEqual('Glob()'.length + 120);
    expect(t.endsWith('…)')).toBe(true);
  });
});

describe('details and output', () => {
  it('counts edited lines', () => {
    expect(editStats('Edit', { old_string: 'a\nb', new_string: 'a' })).toBe('+1 −2');
    expect(editStats('Write', { content: 'a\nb\nc' })).toBe('3 lines');
    expect(editStats('Read', {})).toBeUndefined();
  });

  it('renders todos as check marks', () => {
    const todos = [
      { content: 'done', status: 'completed' },
      { content: 'doing', activeForm: 'Doing it', status: 'in_progress' },
      { content: 'later', status: 'pending' },
    ];
    expect(todoDetails({ todos })).toBe('☑ done  ◐ Doing it  ☐ later');
  });

  it('summarizes output as a short tail', () => {
    expect(summarizeOutput('Bash', 'a\nb\nc\nd\ne\nf')).toBe('… +2 lines\nc\nd\ne\nf');
    expect(summarizeOutput('Bash', 'only')).toBe('only');
    expect(summarizeOutput('Read', 'l1\nl2\nl3')).toBe('3 lines');
    expect(summarizeOutput('Edit', 'ok')).toBeUndefined();
    expect(summarizeOutput('Bash', '<tool_use_error>   ')).toBeUndefined();
  });
});

describe('formatting numbers', () => {
  it('formats durations like a terminal timer', () => {
    expect(fmtDuration(4_200)).toBe('4s');
    expect(fmtDuration(72_000)).toBe('1m12s');
    expect(fmtDuration(600_000)).toBe('10m00s');
  });

  it('formats tokens in thousands', () => {
    expect(fmtTokens(999)).toBe('999');
    expect(fmtTokens(38_240)).toBe('38.2k');
  });
});
