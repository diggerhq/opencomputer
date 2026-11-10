import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codexHome, configToml, spawnEnv, writeHome } from './config.js';

let dir: string | undefined;
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

describe('config', () => {
  it('config.toml: the loopback provider, no approvals of its own, the fork trusted, the key kept from commands', () => {
    expect(
      configToml({ model: 'gpt-6.1-sol', port: 4242, cwd: '/data/s/"x"' }),
    ).toBe(`# Written by Calvin for one session; rewritten at every start.
model = "gpt-6.1-sol"
model_provider = "calvin"
approval_policy = "never"
sandbox_mode = "danger-full-access"

[model_providers.calvin]
name = "Calvin"
base_url = "http://127.0.0.1:4242/v1"
env_key = "CALVIN_MODEL_KEY"
wire_api = "responses"
supports_websockets = true

[projects."/data/s/\\"x\\""]
trust_level = "trusted"

[shell_environment_policy]
inherit = "all"
ignore_default_excludes = true
exclude = ["CALVIN_MODEL_KEY"]

[history]
persistence = "none"
`);
  });

  it('one private home per session, and never an auth.json', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'codex-config-'));
    const a = codexHome(dir, 'T1-C1-1.2');
    expect(a).toBe(codexHome(dir, 'T1-C1-1.2'));
    expect(a).not.toBe(codexHome(dir, 'T1-C1-1.3'));
    writeHome(a, 'x = 1\n');
    writeFileSync(path.join(a, 'auth.json'), '{}');
    writeHome(a, 'x = 2\n');
    expect(existsSync(path.join(a, 'auth.json'))).toBe(false);
    expect(readFileSync(path.join(a, 'config.toml'), 'utf8')).toBe('x = 2\n');
    expect(statSync(a).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(a, 'config.toml')).mode & 0o777).toBe(0o600);
  });

  it("the child's environment: an allow-list, its home, the placeholder, the session's secrets", () => {
    const env = spawnEnv(
      {
        PATH: '/bin',
        HOME: '/home/agent',
        SP_FILES_SOCKET: '/run/r1.files',
        SP_TOKEN_SOCKET: '/run/token.sock',
        SP_MODEL_SOCKET: '/run/model.sock',
        CLAUDE_ENV_FILE: '/c.sh',
        RUNNER_SPEC: '{}',
        OPENAI_API_KEY: 'k',
        OPENAI_BASE_URL: 'u',
        CODEX_API_KEY: 'k',
        ANTHROPIC_API_KEY: 'k',
        CLAUDE_CODE_OAUTH_TOKEN: 'k',
        SLACK_BOT_TOKEN: 'k',
        AZURE_OPENAI_API_KEY: 'k',
        BASH_ENV: '/runner/own.sh',
      },
      { home: '/h', envFile: '/e.sh' },
    );
    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/home/agent',
      SP_FILES_SOCKET: '/run/r1.files',
      CODEX_HOME: '/h',
      CALVIN_MODEL_KEY: 'ssh-placeholder',
      RUST_LOG: 'warn',
      BASH_ENV: '/e.sh',
    });
    expect(spawnEnv({ BASH_ENV: '/runner/own.sh' }, { home: '/h' })).not.toHaveProperty('BASH_ENV');
  });
});
