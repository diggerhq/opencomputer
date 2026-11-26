# OpenComputer desktop

The Mac app: an Electron shell around the tracks-and-threads surface. The
design is section 24 of the tracks-and-threads spec (in the knowledge
repository, `product/tracks-and-threads/spec.md`); the bridge is section 42.3.

The shell owns what a page must not: the token, the one socket, the windows
and the notifications. The UI is the surface's desktop bundle (`web/`'s second
Vite entry), served on `oc://app/`. Until that bundle is built, the app serves
a placeholder page that exercises every message of the bridge.

## Layout

| Path | What |
|---|---|
| `src/shared/bridge.ts` | Every message between a page and the main process |
| `src/preload.ts` | Exposes `window.oc`, and nothing else |
| `src/host/` | The desktop `Host` (spec section 25), for the surface's desktop entry: `createDesktopHost()` |
| `src/main/index.ts` | Windows, the fence, notifications, the hotkey, the bridge's other end |
| `src/main/auth.ts` | Sign-in (authorization code with PKCE, loopback redirect) and the token |
| `src/main/scheme.ts` | `oc://app/`: the UI's files, and `/api/*` proxied to the edge with the token |
| `src/main/socket.ts`, `router.ts` | The one socket and its fan-out to windows |
| `src/main/bundle.ts` | Which UI bundle to serve: built-in, or a fetched one whose signature verifies |
| `src/placeholder/` | The stand-in page |
| `test/fake-edge.ts` | The edge's sign-in routes, one API route and the socket, for tests |

## Run

```sh
npm install
OC_EDGE_URL=https://<an edge> npm start      # unpackaged; the edge can be chosen at run time
npm run typecheck && npm test                # unit tests
xvfb-run -a npm run test:e2e                 # the app end to end against the fake edge (no xvfb-run on a Mac)
```

A packaged app reads no environment: its edge is compiled in at build
(`OC_EDGE_URL=… npm run dist`), since whoever could set it would receive the
token.

## The surface's bundle

`build.mjs` copies the surface's desktop build into `ui/` when it finds one
(`OC_UI_DIR` or `../web/dist-desktop`, the output of `npm run build:desktop` in `web`), and the app
serves that in place of the placeholder. What the bundle can rely on:

- It is one document at `oc://app/`. What is open is not in the URL: the
  surface mirrors it with `location` (`/t/<thread>`, `/k/<track>`, `/new`),
  and the shell answers with an `open` message after the page's first
  `hello`: a waiting deep link or notification, or else the mirrored place.
- The hotkey (Option-Space) and File > New Thread send `open` with
  `{ new: true }`.
- Scripts and styles must be files (the content security policy allows no
  inline script, no foreign origin and no frames).
- API calls are `/api/<route>` paths (`/api/feed`, `/api/sessions/…`); the
  main process sends them to the edge's public routes with the token.
- A channel is the main process's socket: on `open`, send `hello` and the
  `sub` frames as section 38.3 says.

`test/e2e/surface.test.ts` runs the bundle in the shell against the SDK's fake
server. `OC_UI=placeholder` (unpackaged only) serves the placeholder page,
which the shell's own tests drive.

## Signing and notarisation

CI (`.github/workflows/desktop.yml`) builds on a Mac runner. With no
certificate the build is **ad-hoc signed**: it runs after
`xattr -dr com.apple.quarantine /Applications/OpenComputer.app`, and it cannot
auto-update. For a build anyone can open, add these repository secrets:

| Secret | What |
|---|---|
| `MAC_CERTIFICATE_P12_BASE64`, `MAC_CERTIFICATE_PASSWORD` | A "Developer ID Application" certificate with its private key, exported as `.p12`, base64 |
| `APPLE_API_KEY_P8_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | An App Store Connect API key (team key, "Developer" role) for `notarytool` |

Both need a paid Apple Developer Program membership for the organization;
the Account Holder creates the certificate.

## Updates

- **The app**: `electron-updater` against the `publish` URL in
  `electron-builder.yml`. The files `npm run dist` writes to `release/`
  (`latest-mac.yml`, the `.zip`, the `.dmg`) are what that URL must serve.
- **The UI bundle**: fetched from `<edge>/desktop/ui/` in the background and
  used at next launch, only if `manifest.sig` verifies against the key
  compiled into the app and every file matches the manifest
  (`scripts/sign-ui.mjs` makes both). With no key compiled in
  (`ui-bundle-key.pub`), a fetched bundle is never used.
