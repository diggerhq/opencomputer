import { describe, expect, it } from "vitest";

import { itemPath, parseItem, readyToClose, sessionTrailers, STATE_LINE_MAX, type ItemPath } from "../src/computer/work/item.js";

/** Work tracking 3.2: an item file read by hand, never rejected. */

const open: ItemPath = { number: 7, stage: "open", slug: "board-api" };
const parse = (body: string, path: ItemPath = open) => parseItem(path, body);

describe("itemPath", () => {
  it("names only NN-slug.md directly under work/ or done/", () => {
    expect(itemPath("work/7-board-api.md")).toEqual({ number: 7, stage: "open", slug: "board-api" });
    expect(itemPath("done/012-old.md")).toEqual({ number: 12, stage: "closed", slug: "old" });
    for (const p of ["work/README.md", "work/x/7-a.md", "work/7-a.txt", "notes/7-a.md", "work/7.md", "work/-a.md", "done/1234567890-a.md"]) {
      expect(itemPath(p)).toBeNull();
    }
  });
});

describe("parseItem", () => {
  it("reads a full item", () => {
    const body = [
      "---",
      "owner: Ana@Example.com",
      "tags: [Board, api, board]",
      "---",
      "# 7. The board API",
      "",
      "Status: in progress",
      "Routes are in; composition next.",
      "",
      "PR: https://github.com/o/r/pull/3, https://github.com/o/r/pull/4.",
      "pr: https://github.com/o/r/pull/3",
      "",
      "## Left",
      "- [x] routes",
      "- [ ] composition",
      "* [X] scopes",
      "",
      "## Notes",
      "- [ ] not counted",
    ].join("\n");
    expect(parse(body)).toEqual({
      title: "The board API",
      stateLine: "Routes are in; composition next.",
      tags: ["board", "api"],
      owner: "ana@example.com",
      left: 1,
      boxes: 3,
      pullRequests: ["https://github.com/o/r/pull/3", "https://github.com/o/r/pull/4"],
      warnings: [],
    });
  });

  it("falls back to the slug and nulls with a warning, never throwing", () => {
    const p = parse("just text\n");
    expect(p.title).toBe("board-api");
    expect(p.stateLine).toBeNull();
    expect(p.left).toBeNull();
    expect(p.owner).toBeNull();
    expect(p.warnings).toEqual(["There is no # title."]);
    expect(parse("").title).toBe("board-api");
  });

  it("warns about an unreadable owner and an unclosed frontmatter", () => {
    expect(parse("---\nowner: Ana, Bob\n---\n# T\n").warnings).toEqual(["owner is not one email: Ana, Bob"]);
    const unclosed = parse("---\nowner: a@b.co\n# T\n");
    expect(unclosed.owner).toBeNull();
    expect(unclosed.warnings).toContain("The frontmatter is not closed with ---.");
  });

  it("strips quotes from frontmatter values", () => {
    const p = parse('---\nowner: "a@b.co"\ntags: "x", \'Y\'\n---\n# T\n');
    expect(p.owner).toBe("a@b.co");
    expect(p.tags).toEqual(["x", "y"]);
  });

  it("cuts the state line, skips headings and Key: value lines", () => {
    const long = "x".repeat(STATE_LINE_MAX + 50);
    expect(parse(`# T\n## Sub\nOwner: me\n${long}\n`).stateLine).toBe("x".repeat(STATE_LINE_MAX));
    expect(parse("# T\n\nhttps://example.com is the link\n").stateLine).toBe("https://example.com is the link");
  });

  it("removes a leading number from the title only", () => {
    expect(parse("# 12 - Ship it\n").title).toBe("Ship it");
    expect(parse("# 2026 plans\n").title).toBe("plans");
    expect(parse("# 42\n").title).toBe("42");
    expect(parse("# Release v2\n").title).toBe("Release v2");
  });

  it("ignores headings, boxes and PR lines inside code blocks", () => {
    const p = parse("# T\n```\n# not a title\n## Left\n- [ ] x\nPR: https://github.com/o/r/pull/1\n```\nstate\n## Left\n- [ ] real\n");
    expect(p.title).toBe("T");
    expect(p.stateLine).toBe("state");
    expect(p.left).toBe(1);
    expect(p.pullRequests).toEqual([]);
  });

  it("warns about an unclosed code block", () => {
    expect(parse("# T\n```\ncode\n").warnings).toEqual(["A code block is not closed."]);
  });

  it("counts only the first ## Left, warns about more and about an empty one", () => {
    const two = parse("# T\n## Left\n- [ ] a\n## left:\n- [ ] b\n- [ ] c\n");
    expect(two.left).toBe(1);
    expect(two.warnings).toEqual(["There is more than one ## Left; only the first is read."]);
    const empty = parse("# T\n## Left\n\n## Next\n");
    expect(empty.left).toBe(0);
    expect(empty.warnings).toEqual(["## Left is empty."]);
  });

  it("ends ## Left at a heading of level 2 or above, not at a level 3", () => {
    const p = parse("# T\n## Left\n### API\n- [ ] a\n### Web\n- [x] b\n# Other\n- [ ] c\n");
    expect(p.left).toBe(1);
    expect(p.boxes).toBe(2);
  });

  it("reads a body with CRLF and a byte order mark", () => {
    const p = parse("﻿---\r\nowner: a@b.co\r\n---\r\n# T\r\nline\r\n");
    expect(p.owner).toBe("a@b.co");
    expect(p.title).toBe("T");
    expect(p.stateLine).toBe("line");
  });
});

describe("readyToClose", () => {
  it("is open, with boxes under ## Left and none unchecked", () => {
    expect(readyToClose("open", { left: 0, boxes: 2 })).toBe(true);
    expect(readyToClose("open", { left: 1, boxes: 2 })).toBe(false);
    expect(readyToClose("open", { left: 0, boxes: 0 })).toBe(false);
    expect(readyToClose("open", { left: null, boxes: 0 })).toBe(false);
    expect(readyToClose("closed", { left: 0, boxes: 2 })).toBe(false);
  });
});

describe("sessionTrailers", () => {
  it("reads Session: lines, once each", () => {
    expect(sessionTrailers("Update 7\n\nSession: cs_abc123\nSession: cs_abc123\nSession: run:42\n")).toEqual(["cs_abc123", "run:42"]);
    expect(sessionTrailers("Session: has spaces in it\nSession:\n")).toEqual([]);
  });
});
