// The seam for a computer's model access: the Durable Object imports
// `createModelAccess` from here and nothing else about it. In this build
// every session runs on the organization's managed models (model-access.ts);
// a build with subscription routing replaces this file.

import { type ModelAccess, type ModelAccessDeps, noModelAccess } from "./model-access.js";

export function createModelAccess(deps: ModelAccessDeps): ModelAccess {
  return noModelAccess(deps);
}
