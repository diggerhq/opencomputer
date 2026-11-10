// What a session may use (objects.mdx#capabilities), as the writer serves it in
// `sessions.attached`. Published as schema/capabilities.v1.json (scripts/
// api-schema.mjs; capabilities.test.ts holds this list to it): blue vendors
// that file and tests its own copy, which it checks create and PATCH against
// and serves over HTTP, against it (review r1 contract 7, r2 P2-5). Static: it
// changes with a release.

import type { Capabilities } from './schema-objects.js';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

const CAPABILITIES: Capabilities = {
  models: [
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', efforts: EFFORTS, contextWindow: 1_000_000, default: true },
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', efforts: EFFORTS, contextWindow: 1_000_000, default: false },
    { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', efforts: ['low', 'medium', 'high'], contextWindow: 200_000, default: false },
    { id: 'claude-fable-5-2', name: 'Claude Fable 5.2', efforts: EFFORTS, contextWindow: 1_000_000, default: false },
    { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', efforts: EFFORTS, contextWindow: 1_000_000, default: false },
    { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol (Codex)', efforts: ['low', 'medium', 'high', 'xhigh'], contextWindow: 400_000, default: false },
  ],
  modes: ['default', 'acceptEdits', 'plan', 'bypassPermissions'],
  features: { steer: true, compact: true, terminal: true, workspace: true, reasoning: true, subagents: true },
};

export function capabilities(): Capabilities {
  return CAPABILITIES;
}
