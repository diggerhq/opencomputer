import { describe, expect, it } from 'vitest';
import { isBaseUrlName, secretNameProblem } from './secret-names.js';

describe('secretNameProblem', () => {
  it('accepts ordinary environment variable names', () => {
    for (const n of ['MONID_API_KEY', 'gcp_sa', '_X1']) expect(secretNameProblem(n)).toBeUndefined();
  });
  it('refuses malformed names', () => {
    for (const n of ['', '1ABC', 'A-B', 'A B', 'X'.repeat(65)]) expect(secretNameProblem(n)).toMatch(/letters, digits/);
  });
  it('refuses names that would change how the session runs', () => {
    for (const n of ['PATH', 'HOME', 'SP_RUN', 'CLAUDE_ENV_FILE', 'ANTHROPIC_API_KEY', 'GIT_ASKPASS', 'LD_PRELOAD', 'NODE_OPTIONS', 'BASH_ENV', 'HTTPS_PROXY', 'https_proxy', 'PROMPT_COMMAND', 'PYTHONSTARTUP', 'NODE_EXTRA_CA_CERTS'])
      expect(secretNameProblem(n)).toMatch(/reserved/);
  });
  it('refuses names that redirect where tools fetch code or send traffic, as secrets and variables', () => {
    for (const n of ['PIP_INDEX_URL', 'GOPROXY', 'DOCKER_HOST', 'JAVA_TOOL_OPTIONS', 'LESSOPEN', 'NPM_CONFIG_REGISTRY', 'XDG_CONFIG_HOME', 'http_proxy']) {
      expect(secretNameProblem(n)).toMatch(/reserved/);
      expect(secretNameProblem(n, { variable: true })).toMatch(/reserved/);
    }
  });
  it('allows a base URL only as a variable', () => {
    for (const n of ['OPENAI_BASE_URL', 'openai_base_url', 'OPENAI_API_BASE', 'MY_SERVICE_BASE_URL']) {
      expect(secretNameProblem(n)).toMatch(/base URL/);
      expect(secretNameProblem(n, { variable: true })).toBeUndefined();
    }
    expect(isBaseUrlName('OPENAI_BASE_URL')).toBe(true);
    expect(isBaseUrlName('BASE_URL_NOTE')).toBe(false);
  });
});
