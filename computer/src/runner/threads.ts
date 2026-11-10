// read_thread and post_thread (work 049 L3): a session reads a Slack thread on
// demand (a link found in a file, a brief or an earlier message, or to refresh
// one) and posts a reply into one when the person asks. The request goes
// runner → host → gateway, which runs the access check: in production
// (the backend) public channels only, readable by both the app and the session's
// owner. The runner never holds a Slack token for another conversation.
//
// A read comes back as the same delimited block a linked thread gets
// (`linkedBlock`), so the model sees on-link and on-demand reads alike: as data
// written by other people, never as instructions. read_thread never prompts;
// post_thread asks for approval outside bypass mode (prompts.ts).

import { tool } from './tool.js';
import { z } from 'zod';
import { type Linked, linkedBlock } from '../links.js';
import type { PostThreadRequest, PostThreadResult, ReadThreadRequest } from '../protocol.js';

export const READ_THREAD_TOOL = 'mcp__calvin__read_thread';
export const POST_THREAD_TOOL = 'mcp__calvin__post_thread';
/** Bounds per runner, which matter in bypass mode where nobody approves each call and reads never prompt. */
export const MAX_POSTS = 20;
export const MAX_POST_CHARS = 4_000;
export const MAX_READS = 40;

/** What the process hosting the session wires: the gateway answers both. */
export interface ThreadHooks {
  read(req: ReadThreadRequest): Promise<Linked>;
  post(req: PostThreadRequest): Promise<PostThreadResult>;
}

const where = {
  url: z.string().optional().describe('The thread\'s Slack link (Copy link on a message: https://<workspace>.slack.com/archives/<channel>/p<ts>)'),
  channel: z.string().optional().describe('Without a link: the channel id (C…)'),
  ts: z.string().optional().describe('Without a link: the ts of a message in the thread, e.g. 1700000000.000100'),
};

/** The thread a tool call names, or why it names none. */
export function threadRequest(input: { url?: string; channel?: string; ts?: string }): ReadThreadRequest | string {
  const url = input.url?.trim();
  if (url) return { url };
  const channel = input.channel?.trim();
  const ts = input.ts?.trim();
  if (channel && ts) {
    if (!/^[CG][A-Z0-9]+$/.test(channel)) return `\`${channel}\` is not a channel id (C…)`;
    if (!/^\d{10}\.\d{6}$/.test(ts)) return `\`${ts}\` is not a message ts (like 1700000000.000100)`;
    return { channel, ts };
  }
  return 'give the thread\'s link, or a channel id and a message ts';
}

const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], ...(isError ? { isError } : {}) });
const errorOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function threadTools(hooks: ThreadHooks) {
  let posts = 0;
  let reads = 0;
  const read = tool(
    'read_thread',
    'Read a Slack thread: its first message, the latest replies and how many were left out. Give its link, or a channel id and the ts ' +
      'of a message in it. Use it for a thread named in a file, a brief or an earlier message, or to see new replies in one linked ' +
      'before. Only threads in channels you and the person you work for can both read; otherwise it says why not.',
    where,
    async (input) => {
      const req = threadRequest(input);
      if (typeof req === 'string') return text(req, true);
      if (reads >= MAX_READS) return text(`this session already read ${MAX_READS} threads; ask the person before reading more`, true);
      reads++;
      try {
        const linked = await hooks.read(req);
        return text(linkedBlock(linked, true), !linked.ok);
      } catch (e) {
        return text(`could not read the thread: ${errorOf(e)}`, true);
      }
    },
    { alwaysLoad: true },
  );
  const post = tool(
    'post_thread',
    'Post a reply into another Slack thread, for the person you work for, when they ask you to. Give the thread\'s link, or a channel id ' +
      'and the ts of a message in it, and the text (Slack mrkdwn). It posts in the thread, never at the channel\'s top level; ' +
      'channel-wide mentions are neutralized and a line saying who it was posted for, linking this thread, is appended. Not for ' +
      'replying in this thread: just answer. Returns the posted message\'s link.',
    { ...where, text: z.string().min(1).describe(`What to post, at most ${MAX_POST_CHARS} characters`) },
    async ({ text: body, ...input }) => {
      if (posts >= MAX_POSTS) return text(`this session already posted ${MAX_POSTS} times to other threads; ask the person before posting more`, true);
      if (body.length > MAX_POST_CHARS) return text(`text is ${body.length} characters; at most ${MAX_POST_CHARS}`, true);
      const req = threadRequest(input);
      if (typeof req === 'string') return text(req, true);
      try {
        const r = await hooks.post({ ...req, text: body });
        posts++;
        return text(`Posted: ${r.url}`);
      } catch (e) {
        const why = errorOf(e); // the gateway's own refusals start "not posted:"
        if (/^no answer from the gateway within/.test(why)) {
          // The gateway may still post it: counts, and says not to try again blind.
          posts++;
          return text(`${why}; it may still have been posted, so read the thread before trying again`, true);
        }
        return text(why.startsWith('not posted') ? why : `not posted: ${why}`, true);
      }
    },
    { alwaysLoad: true },
  );
  return [read, post];
}
