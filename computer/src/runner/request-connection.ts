// request_connection (serverless-agents-ws work 080): the computer uses only
// connections people grant it. When a call answers connection_not_found, the
// agent asks here; the gateway posts a "Grant …" button in the thread, and
// whoever clicks it grants one of their own connections in a private form.
// The host stamps the session, so a thread asks only for itself.

import { tool } from './tool.js';
import { z } from 'zod';
import type { ConnectionRequest } from '../protocol.js';
import { errorText } from '../log.js';

/** The services the gateway grants (managed-agents computer/connections.ts); GitHub reaches sessions through its own tokens. */
export const CONNECTION_SERVICES = ['linear', 'gmail', 'calendar', 'drive', 'sheets'] as const;

export function requestConnectionTool(ask: (req: ConnectionRequest) => Promise<void>) {
  const asked = new Set<string>();
  const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });
  return tool(
    'request_connection',
    'Ask the person in this Slack thread to grant you a connection to a service (Linear, Gmail, Google Calendar, ' +
      'Drive or Sheets) when a call through it answers connection_not_found. This posts a button; they pick one of their ' +
      'own connections in a private Slack form, for this thread or all their threads. Never ask for their tokens instead. ' +
      'After calling this, end your turn and wait: you get a message when it is granted. `opencomputer connection grants` ' +
      'shows what is granted.',
    {
      service: z.enum(CONNECTION_SERVICES).describe('The service to connect'),
      reason: z.string().min(3).max(200).describe('One line: what you need it for, shown to the person'),
    },
    async ({ service, reason }) => {
      if (asked.has(service)) return fail(`already asked for ${service} in this session; ask the person in chat whether they saw the button`);
      try {
        await ask({ service, reason: reason.replace(/\s+/g, ' ').trim() });
        asked.add(service);
        return { content: [{ type: 'text' as const, text: `Asked for ${service} in the thread. End your turn now; you get a message when it is granted.` }] };
      } catch (e) {
        return fail(`could not ask: ${errorText(e)}`);
      }
    },
    { alwaysLoad: true },
  );
}
