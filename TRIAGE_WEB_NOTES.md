# Triage (web): design notes

Second pass on the Triage screen (ux-spec 3). What the screen does is
unchanged; how it is arranged and answered is redesigned. Same family as the
Board's visual pass (WORK_WEB_NOTES.md): Inter, `text-sm` (14/20) for names
and body, `text-xs` (12/16, 12/20) for everything quiet, warm neutral tokens,
1px `border`, `rounded-lg`/`rounded-xl` panels, a 4/8 px rhythm, tabular
numerals for ages, amber only for "needs you".

## The person's loop

They arrive with 3-10 things waiting, each worth 5-30 seconds. Their eyes go:
headline (what is needed) -> the thing to decide on (the command, the options,
the secret) -> the agent's last words for context -> one click. Nothing of
that requires scrolling, and nothing on screen offers two ways to do the same
thing.

Prior art: Claude Code / Cursor permission prompts (the exact command, one
click to allow, typing means "no, do this instead"); GitHub's review box (one
text field; the verdict is the submit choice); Slack interactive messages
(the dialog's own buttons, a typed reply declines); Linear Triage and
Superhuman (one item at a time, auto-advance, calm density).

## Layout

- Left list (320 px): "Needs you" (count in amber), then "Set aside", then
  "Agents working". Only "Needs you" is a primary heading (`text-sm`
  medium); the other two are quiet (`text-xs` medium, muted) and their rows
  are muted. A row: a 14 px glyph for the kind of ask (approval, question,
  secret, reply), the headline (`text-sm`, one line), the age (`text-xs`
  tabular, right), and the thread name under it (`text-xs` muted).
- Main column, 720 px of content, centred, three bands:
  1. Header (fixed): thread name (a link to the session) and age, `text-xs`
     muted; then the headline, `text-xl` semibold, at most two lines.
  2. Excerpt (scrolls): no frame. The agent's last words sit at the bottom,
     directly on the dock (the column is bottom-aligned, chat order); older
     turns scroll up under a soft fade and "N earlier messages" heads them.
     The "where it stopped" rule is kept, quieter.
  3. The answer dock (fixed to the bottom with air around it).

## One answer dock, shaped by the ask

One card: the ask attached on top, one text box, one footer. Typing is
always the free-form answer to whatever was asked; there is never a second
input. The footer's left holds the quiet "Set aside"; its right holds the
verdict.

| Ask | Attached on top | Footer actions | Typing + Enter |
|---|---|---|---|
| Approval | Tool label and target (file, cwd, server) on one line; the exact command / diff / file content / arguments in a mono block, wrapped, scrolling past 12 lines | Deny, "Allow for this session" (when `alwaysAllows`), Allow (primary) | The verdict buttons give way to Send: the message declines the call and tells the agent what to do instead (a steer, which declines open asks with the message) |
| Plan approval (ExitPlanMode) | The plan, rendered, scrolling | Keep planning, "Approve, ask before edits", "Approve, accept edits" | Same as approval |
| Question | Options as full-width rows: label and description; single choice answers on click, multiple choice toggles with check boxes | Send (enabled once something is chosen or typed) | Free-form answer to the question (`answers[].text`); typed text alongside a clicked option goes with it as a note |
| Secret | Key glyph, the secret's name (mono), its purpose; "Add in Secrets" button. A masked field can replace the button in place later | Send | A message to the agent (declines the request) |
| Reply (plain text turn, future `attention.reason = reply`) | nothing | Send | The reply |
| Answered elsewhere | "Answered elsewhere" and Next replace the attachment | Send | An ordinary message (queued) |

Answering advances to the next ask at once. A one-line confirmation of what
was sent ("Allowed · Rotate the staging password") shows above the next
headline for a few seconds and blocks nothing. A failed send keeps the text
and the ask on screen, with "Not sent · Retry" in the footer. Empty list:
a calm "All clear".

## What an approval ask carries (API)

`approval: { toolName, callId, input, title, alwaysAllows }`. `input` is the
tool's raw input: Bash `{command, description?, timeout?}` (Codex adds
`cwd`); Edit `{file_path, old_string, new_string}` or `{file_path, diff}`;
MultiEdit `{file_path, edits[]}`; Write `{file_path, content}`; ExitPlanMode
`{plan}`; MCP and Calvin tools their arguments. `title` is Claude Code's
permission title or "Claude wants to use <tool>". The reason/description the
Slack prompt shows is not in the API payload, and neither is the working
directory for Claude sessions.

## Headlines

The headline says what is needed in the person's words, from the payload,
never the tool's id: Bash uses its `description`, else "Run <program
[subcommand]>" (setup lines, `cd x &&`, `sudo`/`env`/`VAR=` prefixes
skipped); Edit/Write "Edit <file>"/"Write <file>"; a plan "Review the plan";
an MCP tool "Merge pull request · github". The Board, the session list and
the transcript's closed-ask line use the same words ("Wants to run psql").
The session view's ask card reuses the same approval detail.
