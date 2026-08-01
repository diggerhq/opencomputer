export function renderDevUI(agentName: string): string {
  const escapedName = agentName
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="opencomputer-agent" content="${escapedName}">
  <title>${escapedName} · OpenComputer dev</title>
  <link rel="stylesheet" href="/assets/dev-ui.css">
</head>
<body>
  <div id="root"></div>
  <script src="/assets/dev-ui.js" defer></script>
</body>
</html>`;
}
