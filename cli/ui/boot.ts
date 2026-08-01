const root = document.getElementById("root");
if (root) root.textContent = "Starting local agent…";

function showFailure(error: unknown): void {
  if (!root) return;
  const message = error instanceof Error ? error.message : String(error);
  root.innerHTML = "";
  const panel = document.createElement("main");
  panel.style.cssText =
    "display:grid;place-content:center;min-height:100vh;padding:32px;" +
    "font:14px/1.5 ui-sans-serif,system-ui;color:#9b3434;background:#f6f6f3;text-align:center";
  const title = document.createElement("strong");
  title.textContent = "The local agent app could not start";
  const detail = document.createElement("p");
  detail.textContent = message;
  panel.append(title, detail);
  root.append(panel);
}

window.addEventListener("error", (event) => showFailure(event.error ?? event.message));
window.addEventListener("unhandledrejection", (event) => showFailure(event.reason));

void import("./main").catch(showFailure);
