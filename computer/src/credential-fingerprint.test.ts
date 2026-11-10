import { describe, expect, it } from 'vitest';
import { credentialFingerprint, subscriptionFingerprint } from './credential-fingerprint.js';

describe('credentialFingerprint', () => {
  it('is undefined without a Claude credential', () => {
    expect(credentialFingerprint(undefined)).toBeUndefined();
    expect(credentialFingerprint({})).toBeUndefined();
  });
  it('tells credentials and endpoints apart, and never contains the credential', () => {
    const a = credentialFingerprint({ anthropicApiKey: 'sk-secret-1' });
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toContain('secret');
    expect(credentialFingerprint({ anthropicApiKey: 'sk-secret-1' })).toBe(a);
    expect(credentialFingerprint({ anthropicApiKey: 'sk-secret-2' })).not.toBe(a);
    expect(credentialFingerprint({ anthropicApiKey: 'sk-secret-1', anthropicBaseUrl: 'https://openrouter.ai/api' })).not.toBe(a);
    expect(credentialFingerprint({ claudeOAuthToken: 'sk-secret-1' })).not.toBe(a);
  });
});

describe('subscriptionFingerprint (work 082)', () => {
  it('names the owner and account, as the gateway computes it, and not the token', () => {
    // Pinned: blue's model-subscriptions.ts computes sha256(`chatgpt\0owner\0accountId`).slice(0, 12); both must agree.
    expect(subscriptionFingerprint('U1', 'chatgpt', 'acct-123')).toBe('df471168c415');
    expect(subscriptionFingerprint('U2', 'chatgpt', 'acct-123')).not.toBe('df471168c415');
  });
});
