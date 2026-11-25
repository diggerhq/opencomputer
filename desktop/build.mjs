// Builds dist/: the main process, the preload, the shell's own pages and the
// placeholder page. If ../web has produced the surface's desktop bundle it is
// copied to ui/, which the app serves in place of the placeholder.
import { build } from 'esbuild'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const at = (...p) => join(here, ...p)

const edge = process.env.OC_EDGE_URL ?? 'https://app.opencomputer.dev'
const keyFile = process.env.OC_UI_KEY_FILE ?? at('ui-bundle-key.pub')
const define = {
  __OC_EDGE__: JSON.stringify(edge),
  __OC_UI_KEY__: JSON.stringify(existsSync(keyFile) ? readFileSync(keyFile, 'utf8') : ''),
  __OC_UPDATE_URL__: JSON.stringify(process.env.OC_UPDATE_URL ?? `${edge}/desktop/updates`),
}

rmSync(at('dist'), { recursive: true, force: true })
const node = { bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], define, sourcemap: true, logLevel: 'warning' }
const page = { bundle: true, platform: 'browser', format: 'iife', target: 'chrome130', define, logLevel: 'warning' }

await Promise.all([
  build({ ...node, entryPoints: [at('src/main/index.ts')], outfile: at('dist/main.cjs') }),
  // A sandboxed preload is one CommonJS file.
  build({ ...node, entryPoints: [at('src/preload.ts')], outfile: at('dist/preload.cjs'), sourcemap: false }),
  build({ ...page, entryPoints: [at('src/shell/signin.ts')], outfile: at('dist/shell/signin.js') }),
  build({ ...page, entryPoints: [at('src/placeholder/placeholder.ts')], outfile: at('dist/placeholder/placeholder.js') }),
])
mkdirSync(at('dist/shell'), { recursive: true })
for (const f of ['signin.html', 'signin.css']) cpSync(at('src/shell', f), at('dist/shell', f))
for (const f of ['index.html', 'placeholder.css']) cpSync(at('src/placeholder', f), at('dist/placeholder', f))

// Lane 4's second Vite entry. Its output directory is theirs to name; either is taken.
rmSync(at('ui'), { recursive: true, force: true })
// The surface's desktop build (`npm run build:desktop` in web): its document is desktop.html.
const surface = [process.env.OC_UI_DIR, at('../web/dist-desktop')].find((d) => d && existsSync(join(d, 'desktop.html')))
if (surface) {
  cpSync(surface, at('ui'), { recursive: true })
  cpSync(at('ui/desktop.html'), at('ui/index.html'))
}
console.log(`built for ${edge}; UI: ${surface ?? 'placeholder'}`)
