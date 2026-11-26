export interface ConnectionCallbackAction {
  label: string;
  href: string;
}

export interface ConnectionCallbackNextStep extends ConnectionCallbackAction {
  title: string;
  description: string;
}

export interface ConnectionCallbackOptions {
  provider: string;
  status: "success" | "error";
  /** Overrides the default one-line explanation under the heading. */
  message?: string;
  /** The suggested next action; rendered as the primary button. */
  nextStep?: ConnectionCallbackNextStep;
  /** The dashboard root; rendered as a secondary link when present. */
  dashboardUrl?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Only absolute http(s) links are rendered; anything else is dropped. */
function safeHref(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? escapeHtml(url.toString())
      : undefined;
  } catch {
    return undefined;
  }
}

export function renderConnectionCallback(
  options: ConnectionCallbackOptions,
): string {
  const provider = escapeHtml(options.provider);
  const success = options.status === "success";
  const title = success
    ? `${provider} connected`
    : `${provider} connection failed`;
  const eyebrow = success ? "Connection complete" : "Connection incomplete";
  const message = options.message
    ? escapeHtml(options.message)
    : success
      ? `OpenComputer can now use ${provider} within the connection's configured scope.`
      : `OpenComputer could not finish connecting ${provider}. Go back to where you started and try again.`;
  const dashboardHref = safeHref(options.dashboardUrl);
  const nextHref = success ? safeHref(options.nextStep?.href) : undefined;
  const nextStep =
    nextHref && options.nextStep
      ? `<section class="next" aria-labelledby="next-title">
        <div class="label">Next step</div>
        <h2 id="next-title">${escapeHtml(options.nextStep.title)}</h2>
        <p>${escapeHtml(options.nextStep.description)}</p>
      </section>`
      : "";
  const actions: string[] = [];
  if (nextHref && options.nextStep) {
    actions.push(
      `<a class="button primary" href="${nextHref}">${escapeHtml(options.nextStep.label)}<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4"/></svg></a>`,
    );
  }
  // One call to action: with a next step, the dashboard stays on the wordmark.
  if (dashboardHref && !actions.length) {
    const label = success ? "Open dashboard" : "Back to dashboard";
    actions.push(`<a class="button primary" href="${dashboardHref}">${label}</a>`);
  }
  const brand = dashboardHref
    ? `<a class="brand" href="${dashboardHref}" aria-label="OpenComputer dashboard">opencomputer</a>`
    : `<span class="brand">opencomputer</span>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="referrer" content="no-referrer">
  <title>${title} · OpenComputer</title>
  <style>
    :root {
      color-scheme: light;
      --paper: hsl(40 33% 97%);
      --card: hsl(40 40% 99%);
      --panel-2: hsl(40 22% 94%);
      --ink: hsl(45 8% 8%);
      --muted: hsl(40 5% 38%);
      --border: hsl(40 14% 87%);
      --tone: ${success ? "hsl(142 68% 27%)" : "hsl(0 65% 42%)"};
      --tone-bg: ${success ? "hsl(142 44% 92%)" : "hsl(0 66% 95%)"};
      --sans: "Inter Variable", Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --mono: "Geist Mono Variable", "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: var(--paper); color: var(--ink); font: 14px/1.5 var(--sans); -webkit-font-smoothing: antialiased; }
    header { display: flex; align-items: center; height: 56px; padding: 0 24px; border-bottom: 1px solid var(--border); }
    .brand { color: var(--ink); font: 600 17px var(--mono); letter-spacing: -.02em; text-decoration: none; }
    main { width: min(560px, calc(100% - 32px)); margin: clamp(48px, 12vh, 120px) auto 64px; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 6px; }
    .summary { padding: 28px 28px 24px; }
    .status { display: inline-flex; align-items: center; gap: 8px; padding: 3px 9px 3px 7px; border-radius: 3px; background: var(--tone-bg); color: var(--tone); font: 500 12px var(--mono); }
    .status svg { width: 14px; height: 14px; }
    h1 { margin: 16px 0 0; font-size: 24px; font-weight: 600; line-height: 1.25; letter-spacing: -.01em; overflow-wrap: anywhere; }
    .summary p { margin: 8px 0 0; color: var(--muted); font-size: 14px; line-height: 1.6; }
    .next { padding: 20px 28px; border-top: 1px solid var(--border); background: var(--panel-2); }
    .label { color: var(--muted); font: 500 11px var(--mono); letter-spacing: .04em; text-transform: uppercase; }
    h2 { margin: 6px 0 0; font-size: 15px; font-weight: 600; }
    .next p { margin: 4px 0 0; color: var(--muted); line-height: 1.6; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; padding: 16px 28px; border-top: 1px solid var(--border); }
    .actions:empty { display: none; }
    .button { display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 14px; border-radius: 4px; border: 1px solid var(--ink); font-weight: 500; font-size: 14px; text-decoration: none; transition: opacity .15s, background .15s; }
    .button svg { width: 14px; height: 14px; }
    .button:focus-visible { outline: 3px solid hsl(45 5% 48% / .5); outline-offset: 1px; }
    .primary { background: var(--ink); color: var(--paper); }
    .primary:hover { opacity: .88; }
    .note { margin: 16px 2px 0; color: var(--muted); font-size: 13px; line-height: 1.6; }
    @media (max-width: 520px) {
      header { padding: 0 16px; }
      .summary, .next, .actions { padding-left: 20px; padding-right: 20px; }
      .button { flex: 1 1 100%; justify-content: center; }
    }
  </style>
</head>
<body>
  <header>${brand}</header>
  <main>
    <div class="card">
      <section class="summary" aria-live="polite">
        <span class="status">${
          success
            ? `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>`
            : `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M8 4v5M8 12h.01"/></svg>`
        }${eyebrow}</span>
        <h1>${title}</h1>
        <p>${message}</p>
      </section>
      ${nextStep}
      <div class="actions">${actions.join("")}</div>
    </div>
    <p class="note">${
      success
        ? "Started from the terminal? It picks up the connection on its own, so you can close this tab."
        : "Started from the terminal? It shows the details there."
    }</p>
  </main>
</body>
</html>`;
}
