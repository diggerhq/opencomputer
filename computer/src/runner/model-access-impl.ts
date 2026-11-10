// The seam for the runner's model access: runner/main.ts imports
// `createRunnerModelAccess` from here and nothing else about it. In this
// build a runner holds managed credentials only (model-access.ts); a build
// with subscription routing replaces this file.

import { type RunnerModelAccess, type RunnerModelAccessDeps, noRunnerModelAccess } from './model-access.js';

export function createRunnerModelAccess(deps: RunnerModelAccessDeps): RunnerModelAccess {
  return noRunnerModelAccess(deps);
}
