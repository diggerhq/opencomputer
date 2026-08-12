#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const moduleReference = process.env.OPENCOMPUTER_CREATE_START_MODULE_PATH
  ? pathToFileURL(process.env.OPENCOMPUTER_CREATE_START_MODULE_PATH).href
  : "@opencomputer/cli/create-start";
const { runCreateStart } = await import(moduleReference);

await runCreateStart(process.argv.slice(2));
