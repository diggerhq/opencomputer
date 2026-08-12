#!/usr/bin/env node

import { runCreateStart } from "./create-start.js";

runCreateStart(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(
    `create-start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
