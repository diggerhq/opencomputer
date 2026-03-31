/**
 * Desktop Sandbox Demo
 *
 * Demonstrates the remote desktop functionality:
 * 1. Creates a desktop sandbox with Xvfb + openbox
 * 2. Starts VNC streaming (viewable in browser via noVNC)
 * 3. Launches Google Chrome
 * 4. Takes screenshots
 * 5. Programmatic mouse/keyboard input
 * 6. Window management
 *
 * Usage:
 *   npx tsx examples/demo-desktop.ts
 *
 * Environment:
 *   OPENCOMPUTER_API_URL  (default: http://localhost:8080)
 *   OPENCOMPUTER_API_KEY  (default: opensandbox-dev)
 */

import { writeFileSync } from "fs";
import { Desktop } from "../sdks/typescript/src/desktop.js";

const API_URL = process.env.OPENCOMPUTER_API_URL ?? "http://20.101.100.215:8080";
const API_KEY = process.env.OPENCOMPUTER_API_KEY ?? "opensandbox-dev";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(msg: string) {
  console.log(`\n${"=".repeat(60)}\n  ${msg}\n${"=".repeat(60)}`);
}

async function saveScreenshot(desktop: Desktop, name: string) {
  const png = await desktop.screenshot();
  const path = `/tmp/${name}.png`;
  writeFileSync(path, png);
  console.log(`  Screenshot saved: ${path} (${(png.length / 1024).toFixed(1)} KB)`);
}

async function main() {
  // ── Step 1: Create desktop sandbox ─────────────────────────────────
  log("Step 1: Creating desktop sandbox...");
  const desktop = await Desktop.create({
    apiUrl: API_URL,
    apiKey: API_KEY,
    memoryMB: 4096,
    timeout: 600,
  });
  console.log(`  Sandbox ID: ${desktop.sandboxId}`);
  console.log(`  Status: ${desktop.status}`);

  // ── Step 2: Start VNC streaming ────────────────────────────────────
  log("Step 2: Starting VNC stream...");
  await desktop.stream.start();
  const streamUrl = `http://${desktop.sandboxId}-p6080.20.101.100.215.nip.io:8081/vnc.html?autoconnect=true&resize=scale`;
  console.log(`  Stream URL: ${streamUrl}`);
  console.log(`  Open the URL above in your browser to watch live!`);

  await sleep(2000);

  // ── Step 3: Take initial screenshot (empty desktop) ────────────────
  log("Step 3: Screenshot of empty desktop...");
  await saveScreenshot(desktop, "01-empty-desktop");

  // ── Step 4: Get screen info ────────────────────────────────────────
  log("Step 4: Screen info...");
  const screenSize = await desktop.getScreenSize();
  console.log(`  Resolution: ${screenSize.width}x${screenSize.height}`);
  const cursorPos = await desktop.getCursorPosition();
  console.log(`  Cursor: (${cursorPos.x}, ${cursorPos.y})`);

  await sleep(1000);

  // ── Step 5: Launch Google Chrome ───────────────────────────────────
  log("Step 5: Launching Google Chrome...");
  await desktop.exec.run(
    "google-chrome --no-sandbox --disable-gpu --no-first-run --start-maximized https://example.com > /dev/null 2>&1 &",
    { env: { DISPLAY: ":99" } },
  );
  console.log("  Waiting for Chrome to load...");
  await sleep(5000);
  await saveScreenshot(desktop, "02-chrome-example");

  // ── Step 6: Interact with the browser ──────────────────────────────
  log("Step 6: Clicking in the browser and typing...");

  // Click on the Chrome address bar (approximate position)
  await desktop.leftClick(400, 52);
  await sleep(500);

  // Select all text in the address bar and type a new URL
  await desktop.press(["ctrl", "a"]);
  await sleep(300);
  await desktop.write("https://news.ycombinator.com", { delayMs: 30 });
  await sleep(300);
  await desktop.press("enter");
  console.log("  Navigating to Hacker News...");
  await sleep(5000);
  await saveScreenshot(desktop, "03-hackernews");

  // ── Step 7: Scroll down the page ───────────────────────────────────
  log("Step 7: Scrolling down...");
  // Click in the page content area first
  await desktop.leftClick(500, 400);
  await sleep(300);
  await desktop.scroll("down", 5);
  await sleep(1000);
  await saveScreenshot(desktop, "04-scrolled");

  // ── Step 8: Open a new tab ─────────────────────────────────────────
  log("Step 8: Opening new tab...");
  await desktop.press(["ctrl", "t"]);
  await sleep(1000);
  await desktop.write("https://wikipedia.org", { delayMs: 30 });
  await desktop.press("enter");
  console.log("  Navigating to Wikipedia...");
  await sleep(5000);
  await saveScreenshot(desktop, "05-wikipedia");

  // ── Step 9: Window management ──────────────────────────────────────
  log("Step 9: Window management...");
  const windowId = await desktop.getCurrentWindowId();
  const title = await desktop.getWindowTitle(windowId);
  console.log(`  Current window: ${windowId} - "${title}"`);

  const chromeWindows = await desktop.getApplicationWindows("chrome");
  console.log(`  Chrome windows: ${chromeWindows.length}`);

  // ── Step 10: Right-click context menu ──────────────────────────────
  log("Step 10: Right-click demo...");
  await desktop.rightClick(500, 400);
  await sleep(1000);
  await saveScreenshot(desktop, "06-context-menu");
  // Dismiss the menu
  await desktop.press("escape");
  await sleep(500);

  // ── Step 11: Drag demo ─────────────────────────────────────────────
  log("Step 11: Mouse drag demo...");
  // Move mouse to show cursor movement
  for (let i = 0; i < 5; i++) {
    await desktop.moveMouse(200 + i * 100, 300);
    await sleep(200);
  }
  await saveScreenshot(desktop, "07-final");

  // ── Summary ────────────────────────────────────────────────────────
  log("Demo complete!");
  console.log(`
  Screenshots saved in /tmp/:
    01-empty-desktop.png  - Bare openbox desktop
    02-chrome-example.png - Chrome showing example.com
    03-hackernews.png     - Navigated to Hacker News
    04-scrolled.png       - Scrolled down
    05-wikipedia.png      - Wikipedia in new tab
    06-context-menu.png   - Right-click context menu
    07-final.png          - Final state

  Stream URL (still live):
    ${streamUrl}

  Sandbox will auto-terminate in 10 minutes.
  Press Ctrl+C to exit (sandbox keeps running).
  `);

  // Keep the process alive so the user can interact via noVNC
  console.log("  Keeping sandbox alive... Press Ctrl+C to exit.");
  await new Promise(() => {}); // block forever
}

main().catch((err) => {
  console.error("Demo failed:", err);
  process.exit(1);
});
