// Calvin's tools for a session: send_file and post_card always; spawn_thread,
// read_thread and post_thread, checkout_repo, request_secret, preview and
// unpreview when the process that hosts the session wires the hook that serves
// them (the runner does). `cwd` is read when a tool runs: a spare's tools (work 069)
// exist before its session has a folder.

import { checkoutTool } from './checkout.js';
import { type CardSender, postCardTool } from './post-card.js';
import { type FileSender, sendFileTool } from './send-file.js';
import type { SessionHooks } from './session.js';
import { requestSecretTool } from './session-secrets.js';
import { spawnTool } from './spawn.js';
import { previewTools } from './preview.js';
import { threadTools } from './threads.js';
import type { CalvinTool } from './tool.js';

export function calvinTools(cwd: () => string, hooks: SessionHooks, send: FileSender, card: CardSender): CalvinTool[] {
  return [
    sendFileTool(send),
    postCardTool(card),
    ...(hooks.spawn ? [spawnTool(cwd, hooks.spawn)] : []),
    ...(hooks.threads ? threadTools(hooks.threads) : []),
    ...(hooks.checkout ? [checkoutTool(hooks.checkout)] : []),
    ...(hooks.requestSecret ? [requestSecretTool(hooks.requestSecret, () => hooks.secrets?.names ?? [])] : []),
    ...(hooks.previews ? previewTools(hooks.previews) : []),
  ];
}
