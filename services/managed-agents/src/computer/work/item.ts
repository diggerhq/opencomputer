// An item file of the knowledge repository (work tracking, tech design 3.2), read by hand: no YAML
// or Markdown library. Pure and dependency-free, so the Work index can re-parse stored bodies when
// the rules change (PARSER_VERSION) without a GitHub call.
//
// The parser never rejects a file. What it could not read it reports in `warnings`, which the
// card shows as a small mark. The number (leading digits of the file name) is the item's identity:
// it survives a retitle, a new slug and the move to `done/`.

/** Bump when a rule below changes: the index re-parses every stored body. */
export const PARSER_VERSION = 2;

/** Characters kept of the state line. */
export const STATE_LINE_MAX = 200;

/** Characters of a body that are read; the rest is ignored with a warning. */
export const BODY_MAX = 1_000_000;

/** Characters of one line that are read. */
export const LINE_MAX = 10_000;

/** Characters of the state paragraph gathered before it is made plain and cut. */
const PARAGRAPH_MAX = 2_000;

export type Stage = "open" | "closed";

/** An item's place in the repository: only `NN-slug.md` directly under `work/` or `done/`. */
export interface ItemPath {
  number: number;
  stage: Stage;
  /** The file name without the number, its dash and `.md`. */
  slug: string;
}

/** What the parser reads from one file. */
export interface ParsedItem {
  title: string;
  stateLine: string | null;
  tags: string[];
  /** The frontmatter `owner:`, one email, lowercased; null when absent or unreadable. */
  owner: string | null;
  /** Unchecked `- [ ]` entries under `## Left`; null when there is no such heading. */
  left: number | null;
  /** Checkboxes under `## Left`, checked or not. */
  boxes: number;
  /** URLs on lines that start with `PR:`, in order, without duplicates. */
  pullRequests: string[];
  warnings: string[];
}

const ITEM_FILE = /^(work|done)\/(\d{1,9})-([^/]+)\.md$/;

/** The item a path names, or null when the file is not an item. */
export function itemPath(path: string): ItemPath | null {
  const m = ITEM_FILE.exec(path);
  if (!m) return null;
  return { number: Number(m[2]), stage: m[1] === "work" ? "open" : "closed", slug: m[3]! };
}

/** The title an item has before its body is read: the slug. */
export function slugTitle(slug: string): string {
  return slug;
}

// Every pattern below is anchored and has no nested or adjacent overlapping repetition, so it runs
// in time linear in the line; lines are cut to LINE_MAX first. What a pattern could not do in
// linear time (headings, emails, trailing punctuation) is done by hand.
const CHECKBOX = /^\s*[-*+]\s+\[([ xX])\]/;
const KEY_VALUE = /^[A-Za-z][A-Za-z0-9 _-]{0,40}:(\s|$)/;
const URL_IN_TEXT = /https?:\/\/[^\s<>()[\]"'`]+/g;

/** One file's fields. `path` gives the stage and the slug (the title when there is no heading). */
export function parseItem(path: ItemPath, body: string): ParsedItem {
  const warnings: string[] = [];
  if (body.length > BODY_MAX) {
    warnings.push(`The file is longer than ${BODY_MAX} characters; only the start is read.`);
    body = body.slice(0, BODY_MAX);
  }
  const lines = body.replace(/^﻿/, "").split(/\r?\n/);
  let long = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.length > LINE_MAX) {
      lines[i] = lines[i]!.slice(0, LINE_MAX);
      long = true;
    }
  }
  if (long) warnings.push(`A line is longer than ${LINE_MAX} characters; only its start is read.`);

  // Frontmatter: `---` on the first line, closed by the next `---`.
  let start = 0;
  let owner: string | null = null;
  let tags: string[] = [];
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
    if (end === -1) {
      warnings.push("The frontmatter is not closed with ---.");
    } else {
      start = end + 1;
      for (const line of lines.slice(1, end)) {
        const kv = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
        if (!kv) continue;
        const key = kv[1]!.toLowerCase();
        const value = unquote(kv[2]!.trim());
        if (key === "owner") {
          if (!value) continue;
          if (isEmail(value)) owner = value.toLowerCase();
          else warnings.push(`owner is not one email: ${value.slice(0, 80)}`);
        } else if (key === "tags") {
          tags = [...new Set(value.replace(/^\[|\]$/g, "").split(",").map((t) => unquote(t.trim()).toLowerCase()).filter(Boolean))];
        }
      }
    }
  }

  let title: string | null = null;
  let titleAt = -1;
  let stateLine: string | null = null;
  let left: number | null = null;
  let boxes = 0;
  let leftHeadings = 0;
  let inLeft = false;
  let leftContent = false;
  const pullRequests: string[] = [];
  let fence: string | null = null;
  let comment = false;
  // The state line is the first paragraph of prose after the title: a paragraph that starts as a
  // `Key: value` field, a list, a table, a quote or HTML is skipped whole, up to the blank line.
  let paragraph: "none" | "skip" | "text" = "none";
  let stateDone = false;
  let stateText = "";
  const endParagraph = () => {
    if (paragraph === "text") stateDone = true;
    paragraph = "none";
  };

  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    const fenceMark = /^(`{3,}|~{3,})/.exec(trimmed)?.[1];
    if (fence) {
      if (fenceMark && fenceMark[0] === fence[0] && fenceMark.length >= fence.length) fence = null;
      if (inLeft) leftContent = true;
      continue;
    }
    if (comment) {
      if (trimmed.includes("-->")) comment = false;
      continue;
    }
    if (trimmed.startsWith("<!--")) {
      endParagraph();
      comment = !trimmed.includes("-->", 4);
      continue;
    }
    if (fenceMark) {
      endParagraph();
      fence = fenceMark;
      if (inLeft) leftContent = true;
      continue;
    }
    const heading = headingOf(line);
    if (heading) {
      endParagraph();
      const { level, text } = heading;
      if (inLeft && level <= 2) inLeft = false;
      if (level === 1 && title === null && text) {
        title = plain(stripNumber(text, path.number)).trim() || text;
        titleAt = i;
      } else if (level === 2 && /^left\s*:?$/i.test(text)) {
        leftHeadings += 1;
        if (leftHeadings === 1) {
          inLeft = true;
          left = 0;
        }
      }
      continue;
    }
    if (inLeft && trimmed) {
      leftContent = true;
      const box = CHECKBOX.exec(line);
      if (box) {
        boxes += 1;
        if (box[1] === " ") left = (left ?? 0) + 1;
      }
    }
    if (/^PR:/i.test(trimmed)) {
      for (const url of trimmed.slice(3).match(URL_IN_TEXT) ?? []) {
        const clean = trimEnd(url, ".,;:!?");
        if (!pullRequests.includes(clean)) pullRequests.push(clean);
      }
    }
    if (!trimmed) {
      endParagraph();
    } else if (titleAt >= 0 && !stateDone) {
      if (paragraph === "none") paragraph = skipsParagraph(trimmed) ? "skip" : "text";
      else if (paragraph === "text" && SETEXT.test(trimmed)) {
        // The paragraph was a heading.
        stateText = "";
        paragraph = "none";
        continue;
      } else if (paragraph === "text" && interrupts(trimmed)) {
        endParagraph();
        continue;
      }
      if (paragraph === "text" && stateText.length < PARAGRAPH_MAX) stateText += (stateText ? " " : "") + trimmed;
    }
  }
  if (stateText) stateLine = cut(plain(stateText.slice(0, PARAGRAPH_MAX)).replace(/\s+/g, " ").trim()) || null;

  if (title === null) warnings.push("There is no # title.");
  if (leftHeadings > 0 && !leftContent) warnings.push("## Left is empty.");
  if (leftHeadings > 1) warnings.push("There is more than one ## Left; only the first is read.");
  if (fence) warnings.push("A code block is not closed.");

  return {
    title: title ?? slugTitle(path.slug),
    stateLine,
    tags,
    owner,
    left,
    boxes,
    pullRequests,
    warnings,
  };
}

/** Ready to close: open, and `## Left` holds at least one checkbox and none unchecked. */
export function readyToClose(stage: Stage, parsed: Pick<ParsedItem, "left" | "boxes">): boolean {
  return stage === "open" && parsed.boxes > 0 && parsed.left === 0;
}

const SETEXT = /^(=+|-+)$/;
const LIST_ITEM = /^([-*+]|\d{1,9}[.)])(\s|$)/;

/** A line that starts a block which is not prose. */
function skipsParagraph(line: string): boolean {
  return KEY_VALUE.test(line) || interrupts(line) || line.startsWith("<") || line.startsWith("![") || isBreak(line);
}

/** A line that ends a paragraph of prose without a blank line before it. */
function interrupts(line: string): boolean {
  return line.startsWith("|") || line.startsWith(">") || LIST_ITEM.test(line) || line.startsWith("<!--");
}

/** A thematic break: three or more of one of `-`, `*`, `_`, spaces between allowed. */
function isBreak(line: string): boolean {
  const mark = line[0];
  if (mark !== "-" && mark !== "*" && mark !== "_") return false;
  let n = 0;
  for (const c of line) {
    if (c === mark) n++;
    else if (c !== " " && c !== "\t") return false;
  }
  return n >= 3;
}

/** The title without the file's own number, when a separator follows it: `# 12 - Ship it`. */
function stripNumber(text: string, number: number): string {
  let i = 0;
  while (i < text.length && text[i]! >= "0" && text[i]! <= "9") i++;
  if (i === 0 || i > 9 || Number(text.slice(0, i)) !== number) return text;
  let j = i;
  while (text[j] === " ") j++;
  const separator = text[j];
  if (separator === undefined || !".:)-–—".includes(separator)) return text;
  return text.slice(j + 1).trim() || text;
}

/**
 * Inline markdown as text: a link or image as its text, code ticks and `**`/`~~` marks dropped.
 * One pass; a bracket's partner is looked for once (the found position is reused), so it is linear.
 */
export function plain(md: string): string {
  let out = "";
  let closeBracket = -2;
  let closeParen = -2;
  for (let i = 0; i < md.length; i++) {
    const c = md[i]!;
    if (c === "!" && md[i + 1] === "[") continue;
    if (c === "[") {
      if (closeBracket !== -1 && closeBracket < i) closeBracket = md.indexOf("]", i + 1);
      if (closeBracket > i && md[closeBracket + 1] === "(") {
        if (closeParen !== -1 && closeParen < closeBracket) closeParen = md.indexOf(")", closeBracket + 2);
        if (closeParen > closeBracket) {
          // The text holds no "]", so this inner pass meets no link and stays linear.
          out += plain(md.slice(i + 1, closeBracket));
          i = closeParen;
          continue;
        }
      }
      out += c;
      continue;
    }
    if (c === "`") continue;
    // `__` is left: it is also part of names (`#__build`, `__init__`).
    if ((c === "*" || c === "~") && md[i + 1] === c) {
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

/** At most STATE_LINE_MAX characters, cut at a word when one is near, with an ellipsis. */
function cut(text: string): string {
  if (text.length <= STATE_LINE_MAX) return text;
  const room = text.slice(0, STATE_LINE_MAX - 1);
  const space = room.lastIndexOf(" ");
  return `${(space > STATE_LINE_MAX * 0.6 ? room.slice(0, space) : room).trimEnd()}…`;
}

function unquote(value: string): string {
  const q = value[0];
  return value.length >= 2 && (q === '"' || q === "'") && value[value.length - 1] === q ? value.slice(1, -1) : value;
}

/**
 * An ATX heading (up to three spaces, one to six `#`, then a space or the end), its closing `#`s
 * removed. By hand: a pattern for the optional closing sequence backtracks on long lines.
 */
export function headingOf(line: string): { level: number; text: string } | null {
  let i = 0;
  while (i < 3 && line[i] === " ") i++;
  let level = 0;
  while (line[i + level] === "#") level++;
  if (level < 1 || level > 6) return null;
  const after = line[i + level];
  if (after !== undefined && after !== " " && after !== "\t") return null;
  let text = line.slice(i + level).trim();
  let end = text.length;
  while (end > 0 && text[end - 1] === "#") end--;
  // A closing run counts only when it is the whole text or follows a space.
  if (end < text.length && (end === 0 || text[end - 1] === " " || text[end - 1] === "\t")) text = text.slice(0, end).trim();
  return { level, text };
}

/** One address: no spaces or separators, one `@`, a dot inside the domain. */
function isEmail(value: string): boolean {
  if (value.length > 254 || /[\s,;<>]/.test(value)) return false;
  const at = value.indexOf("@");
  if (at < 1 || at !== value.lastIndexOf("@")) return false;
  const domain = value.slice(at + 1);
  const dot = domain.indexOf(".");
  return dot > 0 && !domain.endsWith(".");
}

function trimEnd(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1]!)) end--;
  return text.slice(0, end);
}

/** The `Session:` trailers of a commit message (the knowledge clone's hook writes one; 3.4). */
export function sessionTrailers(message: string): string[] {
  const out: string[] = [];
  for (const line of message.split(/\r?\n/)) {
    const m = /^Session:\s*([A-Za-z0-9_.:-]{1,128})\s*$/.exec(line.trim());
    if (m && !out.includes(m[1]!)) out.push(m[1]!);
  }
  return out;
}
