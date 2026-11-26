// Signs a UI bundle for delivery outside the app (spec section 24.1,
// "Updates"): writes manifest.json (a version and every file's SHA-256) and
// manifest.sig (Ed25519 over the manifest's bytes) into the bundle.
//
//   node scripts/sign-ui.mjs <bundle dir> <version> <private key PEM file>
//   node scripts/sign-ui.mjs --keygen <name>     writes <name>.key and <name>.pub
//
// The public key is compiled into the app (ui-bundle-key.pub, or
// OC_UI_KEY_FILE at build). The private key lives in CI's secrets only.
import { createHash, createPrivateKey, generateKeyPairSync, sign } from 'node:crypto'
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const [a, b, c] = process.argv.slice(2)
if (a === '--keygen' && b) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  writeFileSync(`${b}.key`, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  writeFileSync(`${b}.pub`, publicKey.export({ type: 'spki', format: 'pem' }))
  process.exit(0)
}
if (!a || !/^\d+$/.test(b ?? '') || !c) {
  console.error('usage: sign-ui.mjs <bundle dir> <version> <private key PEM file>')
  process.exit(2)
}

for (const f of ['manifest.json', 'manifest.sig']) rmSync(join(a, f), { force: true })
const files = {}
const walk = (dir) => {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path)
    else files[relative(a, path).split(sep).join('/')] = createHash('sha256').update(readFileSync(path)).digest('hex')
  }
}
walk(a)
const manifest = Buffer.from(JSON.stringify({ version: Number(b), files }))
writeFileSync(join(a, 'manifest.json'), manifest)
writeFileSync(join(a, 'manifest.sig'), sign(null, manifest, createPrivateKey(readFileSync(c))))
console.log(`signed ${Object.keys(files).length} files as version ${b}`)
