// The review summary's JSON Schema (src/computer/review.ts → schema/review.v1.json), and the copies
// in the two packages that ship on their own and so cannot import this one: computer/ (its release
// holds computer/ only, computer/deploy/bundle.sh), for the runner's `review_summary` tool, and
// services/managed-agents (its build's root is its src/), for Org's `review.save`. With --check it
// fails when one differs from what the source emits; review.test.ts here, and a test in each of
// those packages, hold the copies to it too.
//
//   npm run schema            write all three
//   npm run schema -- --check compare only

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { reviewJsonSchema } from "../src/computer/review.js";

const SDK = path.resolve(import.meta.dirname, "..");
const REVIEW_SCHEMA_FILES = ["schema/review.v1.json", "../../computer/schema/review.v1.json", "../../services/managed-agents/src/org/review.v1.json"].map((f) => path.join(SDK, f));
const text = `${JSON.stringify(reviewJsonSchema(), null, 2)}\n`;

let stale = 0;
for (const file of REVIEW_SCHEMA_FILES) {
  if (!process.argv.includes("--check")) writeFileSync(file, text);
  else if ((() => { try { return readFileSync(file, "utf8"); } catch { return ""; } })() !== text) {
    console.error(`${path.relative(process.cwd(), file)} is stale: run npm run schema in sdks/typescript`);
    stale++;
  }
}
process.exit(stale ? 1 : 0);
