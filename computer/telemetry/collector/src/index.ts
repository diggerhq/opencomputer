// Worker entry. workerd treats every export of this module as a handler, so
// it exports only the default; the logic and its contract are in handler.ts.

import { type Env, handle } from './handler.js';

export default {
  fetch: (req: Request, env: Env) => handle(req, env),
};
