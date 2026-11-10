// The runner's first import: RUNNER_ENV variables the host set empty are
// unset before any module reads process.env (several read it as they load).
//
// Invariant: imported first by runner/main.ts, and imports nothing that reads
// the environment.

import { dropEmpty } from '../runner-env.js';

dropEmpty(process.env);
