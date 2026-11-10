// The seam for the host's model access: host/main.ts imports
// `createHostModelAccess` from here and nothing else about it. This build
// runs every session on the organization's managed credentials
// (model-access.ts); a build with subscription routing replaces this file.

import { type HostModelAccess, type HostModelAccessDeps, noHostModelAccess } from './model-access.js';

export function createHostModelAccess(deps: HostModelAccessDeps): HostModelAccess {
  return noHostModelAccess(deps);
}
