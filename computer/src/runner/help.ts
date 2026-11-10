// `!help`: the command list a thread shows. Pure text, so the session only
// supplies the current model and mode.

export function helpText(model: string, mode: string) {
  return [
    `*Commands* (model \`${model}\` · mode \`${mode}\`)`,
    '`!stop` or `!esc`: stop the current turn',
    '`!! <text>`: interrupt and redirect with new text',
    '`!mode <default|accept|plan|auto|bypass>`: permission mode',
    '`+smart` / `+fast` / `+default` at the start of a message: switch this thread to the smartest model, a quick one, or back to the default',
    '`!model <name|id>`: switch model, e.g. `smart`, `fast` or a model id (no name shows the current one and the choices; on Codex, `smart` is `gpt-6-astra` and `fast` is `gpt-6-luna`)',
    '`!effort <low|medium|high|xhigh|max>`: reasoning effort, `medium` by default, `ultra` too on Codex (no level shows the current one)',
    '`!speed <fast|standard>`: output speed, `fast` by default (Claude\'s fast mode where the model has it, Codex\'s priority tier); no value shows the current one',
    '`!status`: model, effort, mode, context, cost, thread id, cwd, session id',
    '`!diff`: show uncommitted changes',
    '`!secret NAME`: give the session a secret through a private form, never in a message; `!secret help` for more',
    '`!restart`: restart this thread\'s agent on the newest deployed version and current credentials (after the current turn)',
    '`!done`: archive this code channel',
    '`!help`: this list',
    'Start a mention with `ch <task>` (or `channel <task>`) to work in a new code channel instead of a thread.',
  ].join('\n');
}
