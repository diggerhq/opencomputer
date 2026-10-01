export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const STYLE = `
  :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
  main { width: min(440px, calc(100vw - 32px)); padding: 32px 0; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  p { line-height: 1.5; margin: 0 0 12px; color: color-mix(in srgb, CanvasText 80%, transparent); }
  .card { border: 1px solid color-mix(in srgb, CanvasText 15%, transparent); border-radius: 12px; padding: 20px; }
  button, .button { display: inline-block; box-sizing: border-box; width: 100%; padding: 10px 14px; border-radius: 8px;
    border: 1px solid transparent; font: inherit; font-weight: 600; cursor: pointer; text-align: center; text-decoration: none; }
  .primary { background: CanvasText; color: Canvas; }
  .secondary { background: transparent; color: CanvasText; border-color: color-mix(in srgb, CanvasText 25%, transparent); }
  input[type=password] { box-sizing: border-box; width: 100%; padding: 9px 10px; border-radius: 8px; font: inherit;
    border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); background: Canvas; color: CanvasText; }
  form + form, .stack > * + * { margin-top: 10px; }
  details { margin-top: 16px; }
  summary { cursor: pointer; font-size: 14px; }
  .code { font: 600 22px ui-monospace, monospace; letter-spacing: 0.12em; text-align: center; padding: 12px;
    border-radius: 8px; background: color-mix(in srgb, CanvasText 6%, transparent); margin: 12px 0; }
  .muted { font-size: 13px; }
  .warn { color: #b45309; }
  .error { color: #b91c1c; }
`;

export function page(title: string, body: string, headers?: Headers, status = 200): Response {
  const out = new Headers(headers);
  out.set("Content-Type", "text/html; charset=utf-8");
  out.set("Cache-Control", "no-store");
  out.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self' https:; frame-ancestors 'none'; base-uri 'none'");
  out.set("X-Frame-Options", "DENY");
  out.set("Referrer-Policy", "no-referrer");
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`,
    { status, headers: out },
  );
}

export function errorPage(message: string, status = 400): Response {
  return page(
    "OpenComputer",
    `<div class="card"><h1>Couldn't connect</h1><p class="error">${escapeHtml(message)}</p>` +
      `<p class="muted">Close this window and start connecting again from ChatGPT.</p></div>`,
    undefined,
    status,
  );
}
