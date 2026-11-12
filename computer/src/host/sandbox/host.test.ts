import { describe, expect, it } from 'vitest';
import type { Telemetry } from '../../telemetry/emitter.js';
import { sandboxHost } from './host.js';

const deps = (env: NodeJS.ProcessEnv, spares = 0) => ({
  env, run: '/nonexistent/run', data: '/nonexistent/data', root: '/nonexistent/root', version: 'v', spares, tm: {} as Telemetry,
  mint: async () => undefined, serveTokens: () => ({ close() {} }), serveHelper: () => ({}) as never, running: () => false, adopt: async () => undefined, unpreview: () => {},
});

describe('sandboxHost', () => {
  it('does not start without a runner user: sessions would run as the host', () => {
    expect(() => sandboxHost(deps({ SP_IMAGE: 'i:1', SP_IMAGE_ABI: '1' }))).toThrow(/needs a runner user/);
  });

  it('does not start without the image and its ABI', () => {
    expect(() => sandboxHost(deps({ SP_RUNNER_USER: 'root', SP_IMAGE_ABI: '1' }))).toThrow(/needs SP_IMAGE and SP_IMAGE_ABI/);
    expect(() => sandboxHost(deps({ SP_RUNNER_USER: 'root', SP_IMAGE: 'i:1' }))).toThrow(/needs SP_IMAGE and SP_IMAGE_ABI/);
  });

  it('does not start with spares: they are not containers yet', () => {
    expect(() => sandboxHost(deps({ SP_RUNNER_USER: 'root', SP_IMAGE: 'i:1', SP_IMAGE_ABI: '1' }, 2))).toThrow(/SP_POOL_SIZE=0/);
  });
});
