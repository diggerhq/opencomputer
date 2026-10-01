# OpenComputer app for ChatGPT

A remote MCP server (ChatGPT Apps SDK) that lets ChatGPT users run their deployed OpenComputer
agents. Public docs: `docs/agents/chatgpt.mdx`.

- `POST /mcp` — stateless Streamable HTTP MCP endpoint (OAuth bearer, scope `agents`).
- `/authorize`, `/oauth/token`, `/oauth/register`, `/.well-known/*` — OAuth 2.1 authorization
  server from `@cloudflare/workers-oauth-provider` (PKCE S256, dynamic client registration, client
  ID metadata documents, `iss` in authorization responses, RFC 9728 resource metadata).
- `/authorize` connects an OpenComputer account by reusing the CLI device login
  (`/auth/cli/device` → an `osb_` key named "ChatGPT"), or by pasting an existing `osb_` key.

The OpenComputer key is stored only inside the encrypted OAuth grant props. ChatGPT holds opaque
access/refresh tokens; tool results and the widget never contain the key. MCP tools call the
managed-agent API through `@opencomputer/sdk`.

| File | Owns |
| --- | --- |
| `src/index.ts` | OAuth provider wiring and the MCP endpoint |
| `src/authorize.ts` | Consent page, device sign-in polling, API-key connect |
| `src/opencomputer.ts` | Device login, `whoami`, SDK client (manual redirects, origin-bound) |
| `src/tools.ts` | MCP tools and the bounded wait for a turn to finish |
| `src/transcript.ts` | Session + events → transcript view and model-readable text |
| `src/widget.ts` | MCP Apps transcript widget (`ui://opencomputer/session-v1.html`) |

## Develop

```bash
npm ci
npm run typecheck && npm test
```

Preview stack (dev Cloudflare account, after api-edge's `scripts/stack.mjs <devin-name> up`):

```bash
node scripts/stack.mjs devin-<name> up       # prints the MCP URL
node scripts/stack.mjs devin-<name> destroy
```

Production deploys only via `npm run deploy:production`; fill in the production KV namespace id
and route in `wrangler.toml` first.
