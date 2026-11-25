// Calvin's tools for a session: send_file and post_card always; the tools that
// reach the cloud (section 41: start_thread, read_thread, post_thread and the
// work tools), checkout_repo, request_secret, preview and unpreview when the
// process that hosts the session wires the hook that serves them (the runner
// does). `cwd` is read when a tool runs: a spare's tools (work 069) exist
// before its session has a folder. For the same reason the list is one for
// every session: a tool that is not for the session's role says so when it is
// called, and Org enforces the split whatever a runner offers.

import { checkoutTool } from './checkout.js';
import { type CardSender, postCardTool } from './post-card.js';
import { type FileSender, sendFileTool } from './send-file.js';
import type { SessionHooks } from './session.js';
import { requestSecretTool } from './session-secrets.js';
import { startThreadTool } from './spawn.js';
import { previewTools } from './preview.js';
import { threadTools } from './threads.js';
import type { CalvinTool } from './tool.js';
import { trackTools } from './track-tools.js';
import { workTools } from './work-tools.js';

export function calvinTools(cwd: () => string, hooks: SessionHooks, send: FileSender, card: CardSender): CalvinTool[] {
  return [
    sendFileTool(send),
    postCardTool(card),
    ...(hooks.work ? [startThreadTool(cwd, hooks.work), ...threadTools(hooks.work), ...workTools(hooks.work), ...trackTools(hooks.work)] : []),
    ...(hooks.checkout ? [checkoutTool(hooks.checkout)] : []),
    ...(hooks.requestSecret ? [requestSecretTool(hooks.requestSecret, () => hooks.secrets?.names ?? [])] : []),
    ...(hooks.previews ? previewTools(hooks.previews) : []),
  ];
}
