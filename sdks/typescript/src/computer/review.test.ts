import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { reviewJsonSchema, ReviewSummary } from "./review.js";

const full = {
  head: "abc123",
  parts: [
    {
      title: "Rows load in one query",
      claim: "`loadRows` asks once for every row.",
      points: ["The loop is gone."],
      files: [{ path: "src/rows.ts", note: "The query." }, { path: "src/rows.test.ts" }],
      excerpts: [{ path: "src/rows.ts", side: "new", start: 10, end: 14, why: "The query." }],
      eye: [{ text: "The order now comes from the query.", path: "src/rows.ts", line: 12 }],
    },
  ],
};

describe("the review summary", () => {
  it("takes a summary with every field, and the smallest one", () => {
    expect(ReviewSummary.parse(full)).toEqual(full);
    expect(ReviewSummary.safeParse({ head: "h", parts: [{ title: "t", claim: "c", files: [{ path: "a" }] }] }).success).toBe(true);
  });

  it("refuses parts as an object, a part without a claim, and a field it does not know", () => {
    expect(ReviewSummary.safeParse({ head: "h", parts: { a: 1 } }).success).toBe(false);
    expect(ReviewSummary.safeParse({ head: "h", parts: [{ title: "t", files: [{ path: "a" }] }] }).success).toBe(false);
    expect(ReviewSummary.safeParse({ head: "h", parts: [{ title: "t", claim: "c", files: [{ path: "a" }], weight: "eye" }] }).success).toBe(false);
  });

  it("is published as schema/review.v1.json, and computer/ and Org ship the same file (npm run schema)", () => {
    const text = `${JSON.stringify(reviewJsonSchema(), null, 2)}\n`;
    for (const rel of ["../../schema/review.v1.json", "../../../../computer/schema/review.v1.json", "../../../../services/managed-agents/src/actors/org/review.v1.json"])
      expect(readFileSync(path.resolve(import.meta.dirname, rel), "utf8")).toBe(text);
  });
});
