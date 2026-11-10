import { describe, expect, it } from 'vitest';
import { secretNameProblem } from './secret-names.js';

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
});
