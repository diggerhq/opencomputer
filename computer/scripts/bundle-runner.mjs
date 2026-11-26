#!/usr/bin/env node
// The runner as one file, dist/runner.mjs, and its lazy chunks (work 082 step 0b). Loading the
// runner's ~150 modules through tsx costs about 200 ms per runner start, and
// `effect` from node_modules another 100 ms; bundled, with `effect` inlined,
// the same graph loads in about 125 ms. host/launch.ts starts this file when
// the release has it and falls back to tsx when it does not, so a failed
// bundle costs speed, never a runner.
//
// Inlined: src/ and `effect`. External: every other package, so the Agent SDK
// still finds its own Claude Code binary next to itself in node_modules.
// Modules that locate files from `import.meta.dirname` get their source
// directory back (the plugin below), so paths resolve as they do under tsx.
//
// It starts through dist/runner-boot.mjs, written after the bundle, which turns
// on Node's compile cache (the bundle's bytecode, kept across runner starts)
// and source maps before loading it. The source map covers src/ only: Node
// decodes all of a map's mappings when it loads the file, and those of the
// inlined packages cost ~20 ms a start for stack frames nobody reads.
//
// Split at dynamic imports: what main.ts loads only on demand (the Codex
// harness, work 082, and the parts of `effect` only it uses) goes to
// dist/chunks/, so a Claude runner neither reads nor parses it (about 10 ms
// a start when it was inlined). Code both use lands in a shared chunk that
// runner.mjs imports statically.
//
// A second bundle, dist/wire.js, is the relay (work 084; src/wire/main.ts): one
// file, no chunks, same externals and source-dir rewrite, run by
// slack-presence-wire.service. It is not optional like the runner's: the unit
// runs only the bundle, so a failed build fails the release.
//
//   node scripts/bundle-runner.mjs        builds dist/runner.mjs and dist/wire.js; run by provision.sh per release

import path from 'node:path';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { decode, encode } from '@jridgewell/sourcemap-codec';
import { build } from 'esbuild';

const ROOT = path.resolve(import.meta.dirname, '..');
const INLINE = new Set(['effect']);

/** `import.meta.dirname` in a source file → that file's directory, relative to the release root. */
const sourceDirs = {
  name: 'source-dirs',
  setup(b) {
    b.onLoad({ filter: /\/src\/.*\.ts$/ }, async (args) => {
      const text = await readFile(args.path, 'utf8');
      const rel = JSON.stringify(path.relative(ROOT, path.dirname(args.path)));
      return { contents: text.replaceAll('import.meta.dirname', `__spPath.join(__spRoot, ${rel})`), loader: 'ts' };
    });
  },
};

/** Bare imports stay external unless inlined on purpose. */
const externals = {
  name: 'externals',
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      const pkg = args.path.startsWith('@') ? args.path.split('/').slice(0, 2).join('/') : args.path.split('/')[0];
      return INLINE.has(pkg) ? undefined : { path: args.path, external: true };
    });
  },
};

// Chunks are content-hashed: drop the last build's so they do not pile up.
await rm(path.join(ROOT, 'dist/chunks'), { recursive: true, force: true });
await build({
  entryPoints: { runner: path.join(ROOT, 'src/runner/main.ts') },
  outdir: path.join(ROOT, 'dist'),
  entryNames: '[name]',
  chunkNames: 'chunks/[name]-[hash]',
  outExtension: { '.js': '.mjs' },
  splitting: true,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  plugins: [externals, sourceDirs],
  banner: { js: "import __spPath from 'node:path'; const __spRoot = __spPath.resolve(import.meta.dirname, '..');" },
  sourcemap: 'linked',
  sourcesContent: false,
  logLevel: 'warning',
});

await build({
  entryPoints: [path.join(ROOT, 'src/wire/main.ts')],
  outfile: path.join(ROOT, 'dist/wire.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  plugins: [externals, sourceDirs],
  banner: { js: "import __spPath from 'node:path'; const __spRoot = __spPath.resolve(import.meta.dirname, '..');" },
  sourcemap: 'linked',
  sourcesContent: false,
  logLevel: 'warning',
});

// Map src/ only (see above): segments into node_modules go, in every output.
const maps = [path.join(ROOT, 'dist/runner.mjs.map'), path.join(ROOT, 'dist/wire.js.map')];
for (const f of await readdir(path.join(ROOT, 'dist/chunks')).catch(() => [])) if (f.endsWith('.map')) maps.push(path.join(ROOT, 'dist/chunks', f));
for (const MAP of maps) {
  const map = JSON.parse(await readFile(MAP, 'utf8'));
  const own = map.sources.map((s) => !s.includes('node_modules/'));
  map.mappings = encode(decode(map.mappings).map((line) => line.filter((seg) => seg.length > 1 && own[seg[1]])));
  await writeFile(MAP, JSON.stringify(map));
}

await writeFile(
  path.join(ROOT, 'dist/runner-boot.mjs'),
  `// Written by scripts/bundle-runner.mjs: the compile cache and source maps on, then the runner.
import module from 'node:module';
import os from 'node:os';
import path from 'node:path';
// Per user: runners may run as another user than the one whose cache Node's default directory holds.
module.enableCompileCache?.(path.join(os.tmpdir(), \`calvin-compile-cache-\${process.getuid?.() ?? 0}\`));
process.setSourceMapsEnabled(true);
await import('./runner.mjs');
`,
);
