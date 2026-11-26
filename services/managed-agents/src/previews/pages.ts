// The pages a preview visitor sees when there is no app to show (work 074).
// They never name the infrastructure behind a preview (002) and never link
// into Slack or the dashboard: anyone holding a URL can read them.

export const WAKE_PATH = "/__opencomputer/wake";

export type PreviewPage =
  | { kind: "apex" }
  /** 404 for a name that points nowhere; 503 when its origin exists but is not answering, so a monitor can tell the two apart. */
  | { kind: "unavailable"; status?: 404 | 503 }
  | { kind: "asleep" }
  | { kind: "waking" }
  | { kind: "closed"; port: number };

const STYLE = `*{margin:0;padding:0;box-sizing:border-box}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;background:#0a0a0a;color:#e5e5e5}
main{text-align:center;max-width:480px;padding:2rem}
h1{font-size:1.25rem;font-weight:600;margin-bottom:.75rem;color:#f5f5f5}
p{font-size:.875rem;color:#a3a3a3;line-height:1.6}
code{background:#1e1e1e;border:1px solid #333;border-radius:4px;padding:.1rem .4rem;font-family:"SF Mono",SFMono-Regular,Consolas,Menlo,monospace;font-size:.8rem;color:#3b82f6}
button{margin-top:1.25rem;background:#3b82f6;color:#fff;border:0;border-radius:6px;padding:.6rem 1.2rem;font-size:.875rem;cursor:pointer}
.spinner{width:40px;height:40px;margin:0 auto 1.5rem;border:3px solid #333;border-top-color:#3b82f6;border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}`;

function html(title: string, body: string, refreshSeconds?: number): string {
  const refresh = refreshSeconds ? `<meta http-equiv="refresh" content="${refreshSeconds}">` : "";
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${refresh}<title>${title}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

export function renderPage(page: PreviewPage): Response {
  const headers = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-robots-tag": "noindex",
  };
  switch (page.kind) {
    case "apex":
      return new Response(
        html("OpenComputer previews", `<h1>OpenComputer previews</h1><p>Report abuse to abuse@opencomputer.dev.</p>`),
        { status: 200, headers },
      );
    case "unavailable":
      return new Response(
        html("Preview unavailable", `<h1>This preview is not available</h1><p>Ask whoever shared this link.</p>`),
        { status: page.status ?? 404, headers: page.status === 503 ? { ...headers, "retry-after": "5" } : headers },
      );
    case "asleep":
      return new Response(
        html(
          "This preview is asleep",
          `<h1>This preview is asleep</h1><p>The computer it runs on is parked. Waking it takes a minute or two; the app will need to be started again after that.</p><form method="post" action="${WAKE_PATH}"><button type="submit">Wake</button></form>`,
        ),
        { status: 503, headers },
      );
    case "waking":
      return new Response(
        html("Waking up…", `<div class="spinner"></div><h1>Waking up…</h1><p>This page refreshes until the computer is ready.</p>`, 3),
        { status: 503, headers: { ...headers, "retry-after": "3" } },
      );
    case "closed":
      return new Response(
        html(
          `Nothing on port ${page.port}`,
          `<h1>Nothing is running here</h1><p>The computer is up, but nothing is listening on port <code>${page.port}</code>. Ask whoever shared this link. This page refreshes on its own.</p>`,
          5,
        ),
        { status: 503, headers: { ...headers, "retry-after": "5" } },
      );
  }
}
