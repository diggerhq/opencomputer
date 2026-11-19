import { describe, expect, it } from 'vitest';
import { CLAUDE_MODEL_VARS, type ClaudeModel, claudeModelEnv, clearClaudeModelEnv } from './model-env.js';

const SECRET = 'sk-ant-real-credential';
const TTL = { explicit: undefined, preset: {} };

describe("Claude Code's model environment (work 097 C5)", () => {
  it.each(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'] as const)(
    'tokenEnv %s: the runner environment holds only the placeholder, never a credential',
    (tokenEnv) => {
      // Whatever the process was started with, no credential survives.
      const env: NodeJS.ProcessEnv = Object.fromEntries(CLAUDE_MODEL_VARS.map((k) => [k, SECRET]));
      claudeModelEnv(env, { tokenEnv } satisfies ClaudeModel, '/run/api.sock', 'ph', TTL);
      expect(Object.values(env)).not.toContain(SECRET);
      const creds = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'].flatMap((k) => (env[k] ? [env[k]] : []));
      expect(creds).toEqual(['ph']);
    },
  );

  it('clearing removes every model variable', () => {
    const env: NodeJS.ProcessEnv = { HOME: '/h' };
    claudeModelEnv(env, { tokenEnv: 'ANTHROPIC_AUTH_TOKEN' }, '/run/api.sock', 'ph', TTL);
    clearClaudeModelEnv(env);
    for (const k of CLAUDE_MODEL_VARS) expect(env).not.toHaveProperty(k);
  });
});
