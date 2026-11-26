// The review summary of a change (spec S9, R40; the `review` table, section 35): what a thread's
// agent writes about its pull request so a person can read the change as a few parts. Defined once
// here. Its users take it from this file:
// - the surface (web/) reads this source, as it reads the rest of this SDK;
// - Org's `review.save` (services/managed-agents) and the runner's `review_summary` tool (computer/)
//   ship on their own, so each reads a copy of schema/review.v1.json in its own tree, which
//   `npm run schema` emits from `reviewJsonSchema()` and tests hold to it.
// The descriptions are what the agent reads in the tool's input schema: they say what a good
// summary is, field by field.

import { z } from "zod";

const path = z.string().min(1).max(500).describe("A file's path as the diff names it (its new path when renamed)");

export const ReviewExcerpt = z
  .strictObject({
    path,
    side: z
      .enum(["new", "old"])
      .optional()
      .describe("`new` (the default): lines of the file after the change; `old`: before it, for code the change removes"),
    start: z.number().int().min(1).describe("The first line of the excerpt"),
    end: z.number().int().min(1).describe("The last line of the excerpt (at least `start`); keep it short, a few to 30 lines"),
    why: z.string().min(1).max(300).optional().describe("One line: what to see in these lines"),
  })
  .describe("Lines of the diff that show what the part claims: the hunk a reviewer should read, not the whole file");

export const ReviewEye = z
  .strictObject({
    text: z.string().min(1).max(400).describe("What a reviewer should not miss and why: a risk, a judgement call, a behaviour that changed"),
    path: path.optional(),
    line: z.number().int().min(1).optional().describe("The line it is about, on the new side"),
  })
  .describe("A thing worth the reviewer's eye");

export const ReviewFile = z.strictObject({
  path,
  note: z.string().min(1).max(400).optional().describe("One line: what changed in this file; omit for a file whose change is obvious from the part"),
});

export const ReviewPart = z
  .strictObject({
    title: z.string().min(1).max(120).describe("What this part does, in a few words"),
    claim: z
      .string()
      .min(1)
      .max(600)
      .describe("What changed in this part and why, in one or two sentences a reader can check against the excerpts"),
    points: z.array(z.string().min(1).max(300)).max(8).optional().describe("Short points that support or qualify the claim"),
    files: z.array(ReviewFile).min(1).max(300).describe("Every file of the diff that belongs to this part, each in one part only"),
    excerpts: z.array(ReviewExcerpt).max(6).optional().describe("The hunks worth reading for this part, most telling first"),
    eye: z.array(ReviewEye).max(5).optional().describe("What deserves the reviewer's eye in this part; omit when nothing does"),
  })
  .describe("One part of the change: a piece a reviewer can read and judge on its own");

export const ReviewParts = z
  .array(ReviewPart)
  .min(1)
  .max(20)
  .describe("The change as a few parts, in the order a reviewer should read them: the part that carries the change first, rote parts (renames, generated files, tests that follow) last");

/** The body of `PUT /work/results/{id}/review` (`review.save`, section 39). */
export const ReviewSummary = z.strictObject({
  head: z.string().min(1).max(200).describe("The commit the summary describes"),
  parts: ReviewParts,
});

export type ReviewExcerpt = z.infer<typeof ReviewExcerpt>;
export type ReviewEye = z.infer<typeof ReviewEye>;
export type ReviewFile = z.infer<typeof ReviewFile>;
export type ReviewPart = z.infer<typeof ReviewPart>;
export type ReviewSummary = z.infer<typeof ReviewSummary>;

/** `GET /work/results/{id}/review`: the summary, with the result it belongs to. */
export type Review = ReviewSummary & { resultId: string };

export const REVIEW_SCHEMA_ID = "https://opencomputer.dev/schemas/review.v1.json";

/** `ReviewSummary` as JSON Schema (draft 2020-12): what schema/review.v1.json holds. */
export function reviewJsonSchema(): Record<string, unknown> {
  return {
    $id: REVIEW_SCHEMA_ID,
    title: "Review summary",
    ...z.toJSONSchema(ReviewSummary, { target: "draft-2020-12", io: "input" }),
  };
}
