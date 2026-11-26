// read_thread and post_thread on calvin's own gateway (work 049 L3): a
// session reads a Slack thread on demand, or posts into one for its owner.
// The check is L1's (links.ts) with the owner as the one asking and the
// session's conversation as the destination; in production the backend answers
// the same frames under its stricter public-channels-only rule.
//
// A post goes into the thread's root as the app, with channel-wide mentions
// neutralized and a line naming the owner and linking the session's thread.
// Logs carry outcomes and ids, never content.

import type { WebClient } from '@slack/web-api';
import { findPermalinks, type Linked, type LinkResolver } from '../links.js';
import type { PostThreadRequest, PostThreadResult, ReadThreadRequest, SlackSessionSpec } from '../protocol.js';
import type { Store } from './db.js';
import { errorText, log } from '../log.js';

/**
 * `<!channel>`, `<!here>`, `<!everyone>` and `<!subteam^…>` become plain text,
 * which Slack does not turn into mentions with `link_names` off. People's
 * mentions stay: the person may have asked for one. Rewriting runs until
 * nothing changes, since one pass can assemble a new token out of its
 * neighbours (`<<!x|!channel>>`, `<!channel|<!here>>`), and any `<!` still
 * standing is escaped.
 */
export function neutralizeBroadcasts(text: string): string {
  const token = /<!(?!date\^)([^<>|]*)(?:\|([^<>]*))?>/g;
  let out = text;
  for (let i = 0; i < 10; i++) {
    const next = out.replace(token, (_, target: string, label?: string) => label || `@${target.split('^')[0]}`);
    if (next === out) break;
    out = next;
  }
  return out.replace(/<!(?!date\^)/g, '&lt;!');
}

/** The body may not carry its own "Posted for" line: the real one is appended after it. */
export function stripAttribution(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*_?Posted for <@/i.test(line))
    .join('\n');
}

/** A read or post that takes longer than this answers "took too long"; the runner gives up at 30 s. */
const DEADLINE_MS = 25_000;
function deadline<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took too long; ask again to retry`)), DEADLINE_MS).unref();
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

export function threadAccess(store: Store, resolver: LinkResolver) {
  /** The session asking, which must be one the asking host runs. */
  function session(from: string, host: string): SlackSessionSpec {
    const row = store.session(from);
    if (!row || row.host !== host) throw new Error(`unknown session ${from}`);
    return row.spec;
  }

  async function read(from: string, host: string, req: ReadThreadRequest, client: WebClient): Promise<Linked> {
    const spec = session(from, host);
    const linked = await deadline(resolver.one(client, spec.owner.slackUserId, spec.channel, req), 'reading it');
    log.info(`read_thread from ${from}: ${linked.ok ? `read ${linked.messages.length}` : `refused (${linked.reason})`}`);
    return linked;
  }

  async function post(from: string, host: string, req: PostThreadRequest, client: WebClient): Promise<PostThreadResult> {
    const spec = session(from, host);
    const body = stripAttribution(req.text ?? '').trim();
    if (!body) throw new Error('not posted: there is no text');
    const linked = await deadline(resolver.one(client, spec.owner.slackUserId, spec.channel, req), 'checking it').catch((e) => {
      throw new Error(`not posted: ${errorText(e)}`);
    });
    if (!linked.ok) throw new Error(`not posted: ${linked.reason}`);
    const channel = findPermalinks(linked.url)[0]!.channel;
    // The first message of a thread read is its root (links.ts follows a reply to its thread).
    const root = linked.messages[0]!.ts;
    const here = spec.threadTs
      ? (await client.chat.getPermalink({ channel: spec.channel, message_ts: spec.threadTs }).catch(() => undefined))?.permalink
      : undefined;
    const posted = await client.chat.postMessage({
      channel,
      thread_ts: root,
      text: `${neutralizeBroadcasts(body)}\n_Posted for <@${spec.owner.slackUserId}> from ${here ? `<${here}|this thread>` : `<#${spec.channel}>`}._`,
      unfurl_links: false,
      unfurl_media: false,
      link_names: false,
    });
    const ts = posted.ts!;
    const url =
      (await client.chat.getPermalink({ channel, message_ts: ts }).catch(() => undefined))?.permalink ??
      `${linked.url.replace(/\/p\d+.*$/, '')}/p${ts.replace('.', '')}?thread_ts=${root}&cid=${channel}`;
    log.info(`post_thread from ${from}: posted ${channel}:${ts}`);
    return { ts, url };
  }

  return { read, post };
}

export type ThreadAccess = ReturnType<typeof threadAccess>;
