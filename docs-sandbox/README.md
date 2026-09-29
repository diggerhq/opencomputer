# OpenComputer Sandboxes — Holocron docs

Standalone [Holocron](https://holocron.so/) docs site containing only the
**Sandboxes** tab of the main docs (`../docs`). Use this folder to publish the
sandbox docs on Holocron (self-hosted Vite build or holocron.so managed hosting).

## Run

```bash
npm install
npm run dev      # dev server on :5173
npm run build    # production build into dist/
npm start        # serve the built site on :3000
```

## Layout

- `docs.json` — Mintlify-compatible config; navigation mirrors the Sandboxes
  tab of `../docs/docs.json`.
- `*.mdx` — the Sandboxes tab pages, copied verbatim.
- `public/images/` — favicon, logos, and page images.

Links that pointed outside the Sandboxes tab (serverless-agent docs and the
single-page consolidated references) were rewritten to absolute
`https://docs.opencomputer.dev/...` URLs so they keep working wherever this
site is hosted.

To refresh content after upstream docs changes, re-copy the same pages listed
in the Sandboxes tab of `../docs/docs.json` and re-apply the absolute-link
rewrite for pages outside the tab.
