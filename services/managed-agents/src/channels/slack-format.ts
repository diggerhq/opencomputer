function escapeSlackText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const HORIZONTAL_RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

// Splits on `|` delimiters, honouring Markdown backslash escaping (a pipe is
// escaped only when preceded by an odd run of backslashes).
function splitTableRow(line: string): string[] | null {
  const cells: string[] = [];
  let current = "";
  let backslashes = 0;
  let delimiters = 0;
  let endsWithDelimiter = false;
  const trimmedLine = line.trim();
  for (const char of trimmedLine) {
    endsWithDelimiter = false;
    if (char === "\\") {
      backslashes += 1;
      current += char;
      continue;
    }
    if (char === "|") {
      if (backslashes % 2 === 1) {
        current = current.slice(0, -1) + "|";
      } else {
        cells.push(current);
        current = "";
        delimiters += 1;
        endsWithDelimiter = true;
      }
    } else {
      current += char;
    }
    backslashes = 0;
  }
  cells.push(current);
  if (delimiters === 0) return null;
  if (trimmedLine.startsWith("|")) cells.shift();
  if (endsWithDelimiter) cells.pop();
  return cells.map((cell) => cell.trim());
}

function parseTableRow(line: string, columns: number): string[] | null {
  const cells = splitTableRow(line);
  if (cells === null) return null;
  if (cells.length < columns) {
    return [...cells, ...new Array<string>(columns - cells.length).fill("")];
  }
  return cells.slice(0, columns);
}

function renderTable(header: string[], rows: string[][]): string[] {
  const out: string[] = [];
  const hasHeader = header.some((cell) => cell.length > 0);
  if (hasHeader) {
    out.push(header.filter(Boolean).map((cell) => `**${cell}**`).join(" | "));
  }
  for (const row of rows) {
    if (row.every((cell) => cell.length === 0)) continue;
    if (row.length === 2) {
      const [key = "", value = ""] = row;
      out.push(key && value ? `• ${key}: ${value}` : `• ${key || value}`);
    } else {
      const cells = row.map((cell) => (cell.length > 0 ? cell : "—"));
      const [first = "", ...rest] = cells;
      const label = first.includes("*") ? first : `**${first}**`;
      out.push(`• ${[label, ...rest].join(" | ")}`);
    }
  }
  return out;
}

// Slack has no table syntax: flatten Markdown tables into bullet rows and
// drop horizontal rules, which would otherwise render as literal `---`.
function rewriteBlocks(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const separator = lines[i + 1] ?? "";
    const header = TABLE_SEPARATOR.test(separator) ? splitTableRow(line) : null;
    const separatorCells = header === null ? null : splitTableRow(separator);
    if (
      header !== null &&
      separatorCells !== null &&
      separatorCells.length === header.length
    ) {
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length) {
        const row = parseTableRow(lines[i] ?? "", header.length);
        if (row === null) break;
        rows.push(row);
        i += 1;
      }
      out.push(...renderTable(header, rows));
      continue;
    }
    if (HORIZONTAL_RULE.test(line)) {
      i += 1;
      continue;
    }
    out.push(line);
    i += 1;
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

// Cumulative limit for `markdown` blocks in one payload.
const MARKDOWN_BLOCK_LIMIT = 12_000;

export interface SlackMarkdownBody {
  text: string;
  blocks: [{ type: "markdown"; text: string }] | [];
}

// Renders standard Markdown natively (tables, headings, rules) via a Block Kit
// `markdown` block; `text` carries the mrkdwn fallback used for notifications
// and for messages too long for a markdown block. `blocks` is always present
// so a `chat.update` replaces (rather than retains) earlier blocks.
export function markdownMessageBody(markdown: string): SlackMarkdownBody {
  const text = markdownToSlackMrkdwn(markdown).slice(0, 35_000);
  const normalized = markdown.replace(/\r\n?/g, "\n");
  if (normalized.trim().length === 0 || normalized.length > MARKDOWN_BLOCK_LIMIT) {
    return { text, blocks: [] };
  }
  return { text, blocks: [{ type: "markdown", text: normalized }] };
}

export function markdownToSlackMrkdwn(markdown: string): string {
  const tokens: string[] = [];
  const protect = (value: string): string => {
    const token = `\uE000${String(tokens.length)}\uE001`;
    tokens.push(value);
    return token;
  };

  let text = markdown
    .replace(/\r\n?/g, "\n")
    .replace(/[\uE000\uE001]/g, "")
    .replace(/```(?:[a-zA-Z0-9_+-]+)?\n?[\s\S]*?```/g, (block) =>
      protect(block.replace(/^```[a-zA-Z0-9_+-]+\n/, "```\n")),
    )
    .replace(/`[^`\n]+`/g, (code) => protect(code));

  text = rewriteBlocks(text);
  text = escapeSlackText(text);
  text = text.replace(
    /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g,
    (_match, label: string, url: string) =>
      protect(`<${url}|${escapeSlackText(label || "image")}>`),
  );
  text = text.replace(
    /\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^)\s]+)\)/g,
    (_match, label: string, url: string) =>
      protect(`<${url}|${escapeSlackText(label)}>`),
  );
  text = text
    .replace(/^#{1,6}\s+(.+)$/gm, (_match, heading: string) =>
      protect(`*${heading.trim()}*`),
    )
    .replace(/\*\*\*([^*\n]+)\*\*\*/g, (_match, value: string) =>
      protect(`_*${value}*_`),
    )
    .replace(/___([^_\n]+)___/g, (_match, value: string) =>
      protect(`_*${value}*_`),
    )
    .replace(/\*\*([^*\n]+)\*\*/g, (_match, value: string) =>
      protect(`*${value}*`),
    )
    .replace(/__([^_\n]+)__/g, (_match, value: string) =>
      protect(`*${value}*`),
    )
    .replace(/~~([^~\n]+)~~/g, "~$1~")
    .replace(
      /(^|[\s([])\*([^*\n]+)\*(?=$|[\s).,!?:;\]])/gm,
      "$1_$2_",
    )
    .replace(/^&gt;\s?/gm, "> ");

  // Protected values may themselves contain tokens (e.g. inline code inside a
  // heading), so keep restoring until none remain.
  while (text.includes("\uE000")) {
    text = text.replace(/\uE000(\d+)\uE001/g, (_match, index: string) => {
      return tokens[Number.parseInt(index, 10)] ?? "";
    });
  }
  return text;
}
