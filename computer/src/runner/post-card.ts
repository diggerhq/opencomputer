// post_card: the agent posts a native Slack card (metrics, a table, a chart,
// link buttons) into its thread, built from a json-render spec
// (github.com/vercel-labs/json-render). The spec is validated against the
// catalog by @json-render/chat and converted to Block Kit by Chat SDK's Slack
// adapter; nothing else of either runs here.
//
// Invariants: a spec that is invalid or exceeds Slack's limits is refused with
// one issue per problem, so the model can fix it, never degraded silently.
// Cards are static: there is no Button (clicks are not routed back yet), only
// LinkButton. A card holding a secret's value is not posted.

import { cardToBlockKit, cardToFallbackText, type SlackCardElement } from '@chat-adapter/slack/blocks';
import { type CardLimits, CardSpecError, schema, standardComponentDefinitions, toCard } from '@json-render/chat';
import { defineCatalog, type Spec } from '@json-render/core';
import type { KnownBlock } from '@slack/web-api';
import { z } from 'zod';
import { tool } from './tool.js';

export const POST_CARD_TOOL = 'mcp__calvin__post_card';
/** Bounds cards per runner, as send_file bounds files. */
const MAX_CARDS = 50;

const { Button: _, ...components } = standardComponentDefinitions;

/** Slack's per-message caps (Chat SDK's Slack adapter degrades past them; we refuse instead). */
const LIMITS: CardLimits = { tables: 1, charts: 2, fields: 10, tableRows: 100, tableColumns: 20, chartTitle: 50, chartLabel: 20, chartSeries: 12, chartPoints: 20 };

/** The catalog's component list, cut from json-render's own prompt so it follows the package. */
export function componentList(): string {
  const prompt = defineCatalog(schema, { components }).prompt();
  const m = prompt.match(/^AVAILABLE COMPONENTS.*\n\n((?:- .*\n?)+)/m);
  return m ? m[1].trim() : Object.keys(components).join(', ');
}

/** Spec → Slack blocks and fallback text; throws CardSpecError with the issues. */
export function toSlack(spec: Spec): { blocks: KnownBlock[]; text: string } {
  // Chat SDK and its Slack adapter type the same card separately; the adapter converts what Chat SDK builds.
  const card = toCard(spec, { components, limits: LIMITS }) as unknown as SlackCardElement;
  const blocks = cardToBlockKit(card) as KnownBlock[];
  if (blocks.length > 50) throw new CardSpecError([`the card renders to ${blocks.length} Slack blocks; a message holds at most 50`]);
  return { blocks, text: cardToFallbackText(card) || ' ' };
}

/**
 * Posts one card through `post`. `leaks` names a secret the card holds. Never
 * throws: every failure is a reason the model can read.
 */
export function cardSender(post: (text: string, blocks: KnownBlock[]) => Promise<void>, leaks: (data: Buffer) => string | undefined = () => undefined) {
  let sent = 0;
  return async (spec: Spec): Promise<{ ok: boolean; text: string }> => {
    const fail = (text: string) => ({ ok: false, text });
    if (sent >= MAX_CARDS) return fail(`this session already posted ${MAX_CARDS} cards; ask the person before posting more`);
    let msg: { blocks: KnownBlock[]; text: string };
    try {
      msg = toSlack(spec);
    } catch (e) {
      if (e instanceof CardSpecError) return fail(`invalid card spec:\n- ${e.issues.join('\n- ')}`);
      return fail(`could not build the card: ${(e as Error)?.message ?? e}`);
    }
    const leaked = leaks(Buffer.from(JSON.stringify(msg.blocks)));
    if (leaked) return fail(`the card contains the value of the secret $${leaked}; not posted`);
    sent++;
    try {
      await post(msg.text, msg.blocks);
      return { ok: true, text: 'Posted the card to the thread.' };
    } catch (e) {
      sent--;
      const err = e as { data?: { error?: string; response_metadata?: { messages?: string[] } }; message?: string };
      const why = err.data?.response_metadata?.messages?.join('; ');
      return fail(`Slack refused the card: ${err.data?.error ?? err.message ?? e}${why ? ` (${why})` : ''}`);
    }
  };
}

export type CardSender = ReturnType<typeof cardSender>;

const element = z.object({
  type: z.string(),
  props: z.record(z.string(), z.unknown()),
  children: z.array(z.string()),
  repeat: z.unknown().optional(),
  visible: z.unknown().optional(),
});

/** The tool over `send`. */
export function postCardTool(send: CardSender) {
  return tool(
    'post_card',
    'Post a native Slack card into this thread: key numbers, a small table, a chart, link buttons. ' +
      'Use it when structured data reads better as a card than as markdown; prose stays in your reply. ' +
      'The spec is a json-render spec: `root` names the root element, `elements` maps keys to ' +
      '`{ type, props, children }` (leaf elements have `children: []`), optional `state` feeds `{ "$state": "/path" }` props and `repeat`. ' +
      'The root is a Card; group inside it with Section, never another Card. Field goes inside Fields, LinkButton inside Actions. ' +
      'Text is markdown without headings. Every series in a bar, line or area Chart has one value per category. ' +
      'At most one Table (100 rows) and two Charts per card. Components:\n' +
      componentList(),
    {
      spec: z
        .object({ root: z.string(), elements: z.record(z.string(), element), state: z.record(z.string(), z.unknown()).optional() })
        .describe('The json-render spec of the card'),
    },
    async ({ spec }) => {
      const r = await send(spec as Spec);
      return { content: [{ type: 'text' as const, text: r.text }], ...(r.ok ? {} : { isError: true }) };
    },
  );
}
