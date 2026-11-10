---
name: slack-formatting
description: "The full guide to writing a Slack reply that reads well: when to use each formatting tool, how to compose the message, what misrenders (tested on desktop and phone), a pre-send check and an example. Read it when unsure how something will render, or before composing a table, localized dates or a document-like report."
---

# Writing Slack messages readers enjoy

Your replies are standard markdown that Slack renders. This guide says what each tool is for, how to put a message together, and what breaks. Everything stated as a rendering fact was tested live (desktop and Android, 2026-10-14). The values behind it are in your system prompt: flow is the product, information is inventory, emphasis is a budget, and each message should show it was composed with care.

## The palette, and when to reach for each tool

What Slack can render in agent replies (standard markdown plus a few Slack-specific forms), each with the job it's good for. These are facts about the medium plus our experience; which tool fits is the model's call.

**Text and emphasis**
- **Plain paragraphs** are the default. Under about five lines, prose is usually best. One paragraph is **one line in the source**: every newline shows up as a line break, so never hard-wrap prose. Separate paragraphs with one blank line.
- **Bold** (`**text**`): the few words a skimmer must not miss, such as the answer, a verdict or a lead-in label (`**Risk:** …`).
- *Italic* (`*text*` or `_text_`): light stress, titles, terms. ~~Strikethrough~~ (`~~text~~`): something retracted or superseded.
- `Inline code`: identifiers, file names, commands, flags, values, error strings, and **anything containing `*`, `_`, `<` or `#`** (snake_case, globs, `__init__`, math like `2*3`). In prose, stray `*` and `_` turn into italics and bold.

**Structure**
- **Bulleted lists** (`- item`) for parallel items; **numbered lists** (`1. item`) only when order matters. Nest by indenting two spaces. Start each item with the words that carry the information.
- **Bold lead-ins** instead of headings when a reply has a few parts.
- **Headings** (`#`, `##`, `###`): only for long replies with sections someone might jump between. All levels look about the same.
- **Block quotes** (`> text`): quoting a person, a log line or a doc passage. Each quoted line needs its own `>`.
- **Dividers** (`---`): rarely; between truly separate parts.
- **Tables** (GFM pipes): comparing several items across two or more attributes. Keep them **narrow: about 3–4 short columns.** Tables don't wrap; wide ones are clipped and scroll sideways on desktop and phone. Otherwise use a list.
- **Task lists** (`- [ ]`, `- [x]`): a checklist the reader will act on. Done items show struck through. A task item turns *every* item in its list into a checkbox, so keep checklists as separate lists.

**Code**
- **Fenced code blocks** with a language tag (```` ```ts ````, ```` ```sh ````, ```` ```diff ````) for anything multi-line, and for anything meant to be copied. On desktop they get highlighting, a language label, line numbers and a copy button, and ```` ```diff ```` gets red and green lines. **On a phone they're a plain box around text** with no colours or copy button. Say in words what a diff changes.
- One command per block, with no `$` prompt and no output mixed in, so it can be copied and run.
- Put a line of prose between two code blocks; on a phone consecutive blocks merge into one box.
- Keep long logs and diffs out of the message: quote the few lines that matter and attach the rest as a file.

**Links**
- **`[label](url)`**, where the label says what it is: `[opencomputer#55](https://github.com/diggerhq/opencomputer/pull/55)`, `[segment.ts:120](https://github.com/…/segment.ts#L120)`. Never "here".
- Anything that has a URL should be a link. Slack does **not** link `#123`, `org/repo#55`, `@user`, `path:line`, or a domain without `https://`. Write the full URL.
- A bare `https://…` URL becomes a link: on desktop a chip that drops `https://`, on a phone a blue link. Use it when the URL itself is the information; otherwise label it. Streamed replies never show link previews (unfurls).
- URLs with parentheses, and trailing punctuation after a URL, are handled correctly.

**Slack-native forms**
- **Mentions** `<@U123>` notify the person, if they're in the channel. Mention someone only when they need to act, and say what the action is; use their plain name for credit or reference. **Never** use `<!here>`, `<!channel>` or `<!everyone>`.
- **Channels** `<#C123>` show the channel's current name, as a link.
- **Dates** `<!date^UNIX^{date_short_pretty} at {time}|fallback with UTC>` show in each reader's own timezone ("Today at 6:46 PM"). Use them for times that matter across timezones. Tokens: `{date_num}` `{date}` `{date_short}` `{date_long}` `{date_pretty}` `{date_short_pretty}` `{date_long_pretty}` `{time}` `{time_secs}` `{ago}`.
- **Emoji** `:shortcode:` or Unicode. Rare and meaningful: a status marker at the start of a line (✅ passed, ❌ failed, ⚠️ needs attention), always next to words that say the same thing. Never as bullets, decoration or a replacement for a word. Leave a space after a shortcode (`:tada:done` stays literal).

**Beyond text**
- **Images, charts, diagrams, math** don't render from markdown: `![img](url)` shows as a link, and mermaid and `$math$` show as source text. Render them to an image and upload it as a file, with alt text and a one-line takeaway in the message.
- **Long output** (logs, full diffs, reports): upload as a file and summarise in the message.

## Composing the message

What the values have meant in practice so far: worked examples to adapt, not rules to obey.

- **Answer first.** The first one or two sentences hold the answer, verdict or decision, and make sense on their own: that's what a push notification, the unread list or a quick glance shows (iOS pushes reportedly cut at about 255 characters). People read in an F-pattern and skim what's lower down ([NN/g](https://www.nngroup.com/articles/f-shaped-pattern-reading-web-content/)).
- **Lead with the informative words** in headings, bullets and lead-ins: "Deploy blocked: missing secret", not "Status update".
- **Progress is not the reply.** Progress shows as it happens (in Calvin, as task cards and short narration). The final reply stands alone as outcome → evidence → next step, without retelling the process.
- **Small batches.** Send what moves the reader forward now; their next message pulls the rest. Several quick exchanges beat one long report.
- **One question, at the end,** on its own line, when a decision is theirs.
- **Match structure to length:** prose for short replies, bold lead-ins or a list for a few parts, headings only for long ones. Keep the same overall shape from reply to reply (answer → detail → links → next step), so readers learn where to look.
- **Numbers carry units and a baseline:** "p95 420 ms (was 610 ms)", "3 of 12 tests failed". Times that matter across timezones use `<!date^…>`; "in 2 hours" only next to an absolute time.
- **Cite** with labelled links in the sentence, or 1–3 links at the end.
- **Stay in the thread.** Broadcasting a reply to the channel is for rare, channel-wide news.
- **Edits are silent** (no notification, and a bot's message shows no "(edited)"). Fix a fresh message in place; when the meaning changes after people have read it, post anew or say "Edited: …".
- **Accessible by default:** short sentences, abbreviations spelled out on first use, no idioms, no meaning carried by colour or position ("the red line", "see above"), emoji always next to words.

## Pitfalls (tested)

Each of these misrendered in a live test. The fix comes after the arrow.
- Hard-wrapped prose shows ragged line breaks → one line per paragraph.
- `2*3*4`, `src/*/x.ts` and `__init__` in prose lose characters or turn into italics and bold → inline code.
- A line straight after a list joins the last item, and a following numbered list continues the old numbering → leave a blank line after every list.
- Code blocks and headings inside list items collapse into plain text → keep code blocks and headings outside lists.
- Consecutive code blocks merge on a phone → a line of prose between them.
- Wide tables are clipped → 3–4 short columns, or a list.
- `#123`, `path:line`, `github.com/x` aren't links → full URLs.
- `:emoji:word` stays literal → a space after the shortcode.
- HTML (`<br>`, `<details>`, `<kbd>`), footnotes, math and mermaid show as source or misrender → plain text, or an image.
- More than one blank line in a row gives a big gap on a phone → one blank line.
- Fine as written, no escaping needed: `<`, `>`, `&` in prose, `Vec<String>`, URLs with `()` or `_`, and inline code holding any characters.

## Before sending: read it as the reader

This is care, as a habit. Reread the message as the person receiving it, on a phone, between two other things:
1. Is the answer in the first sentence or two, and does it make sense on its own? That's all a push notification or a glance shows.
2. Can anything go without the reader missing it?
3. Does every piece of emphasis (bold, heading, emoji) earn its place? Would the message read better with less?
4. Is everything with a URL a link with a clear label? Is every identifier, path and command in code?
5. Will it render, given the pitfalls above? Lists followed by blank lines, no code inside lists, narrow tables, no hard-wrapped lines.
6. If it asks something, is there exactly one question, easy to find, at the end?
7. Do mentions notify only people who must act?

## Example

A reader asks whether the deploy failed. A careless reply:

```
## Deploy Status Update 🚀🚀

I looked into the deploy and checked several things. First I checked the logs, then the config. It turns out
the deploy failed because the env var DATABASE_URL was missing in prod. See src/config.ts:42 and PR #212.

**Next steps:**
- I can add it
- **Or** you can add it
```

What's wrong with it:
- The heading and emoji spend emphasis on nothing.
- The process is retold, and the answer is buried in line three.
- The hard-wrapped line renders as ragged breaks.
- `DATABASE_URL` sits outside code.
- `path:line` and `PR #212` aren't links.
- The choice is vague.

With care:

```
**The deploy failed: `DATABASE_URL` is not set in prod.** The app exits at startup when it reads the config ([config.ts:42](https://github.com/acme/app/blob/9f3c2a1/src/config.ts#L42)); it came in with [acme/app#212](https://github.com/acme/app/pull/212).

Should I add it to the prod secrets and redeploy?
```
