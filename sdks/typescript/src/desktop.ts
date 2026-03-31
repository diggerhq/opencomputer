/**
 * Desktop sandbox with remote display streaming, screenshots, and input control.
 *
 * Uses Xvfb + x11vnc + noVNC inside the VM. The desktop environment (Xvfb + openbox)
 * is auto-started at sandbox creation. VNC streaming is started on-demand via stream.start().
 *
 * @example
 * ```ts
 * import { Desktop } from "@opencomputer/sdk/dist/desktop.js";
 *
 * const desktop = await Desktop.create();
 * await desktop.stream.start();
 * console.log(desktop.stream.getUrl());
 *
 * // Take a screenshot for AI agent
 * const png = await desktop.screenshot();
 *
 * // Programmatic input
 * await desktop.leftClick(500, 300);
 * await desktop.write("hello world");
 * await desktop.press("enter");
 *
 * await desktop.stream.stop();
 * await desktop.kill();
 * ```
 */

import { Sandbox, type SandboxOpts } from "./sandbox.js";
import type { Exec, ProcessResult, RunOpts } from "./exec.js";
import type { Filesystem } from "./filesystem.js";
import type { Agent } from "./agent.js";
import type { Pty } from "./pty.js";

const MOUSE_BUTTONS = { left: 1, right: 3, middle: 2 } as const;

const KEYS: Record<string, string> = {
  alt: "Alt_L",
  backspace: "BackSpace",
  caps_lock: "Caps_Lock",
  ctrl: "Control_L",
  control: "Control_L",
  del: "Delete",
  delete: "Delete",
  down: "Down",
  end: "End",
  enter: "Return",
  esc: "Escape",
  escape: "Escape",
  f1: "F1", f2: "F2", f3: "F3", f4: "F4", f5: "F5", f6: "F6",
  f7: "F7", f8: "F8", f9: "F9", f10: "F10", f11: "F11", f12: "F12",
  home: "Home",
  insert: "Insert",
  left: "Left",
  page_down: "Page_Down",
  page_up: "Page_Up",
  right: "Right",
  shift: "Shift_L",
  space: "space",
  super: "Super_L",
  tab: "Tab",
  up: "Up",
};

function mapKey(key: string): string {
  return KEYS[key.toLowerCase()] ?? key.toLowerCase();
}

function randomString(length = 16): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  const arr = new Uint8Array(length);
  crypto.getRandomValues(arr);
  for (const b of arr) result += chars[b % chars.length];
  return result;
}

export interface DesktopOpts extends SandboxOpts {
  /** Screen resolution [width, height]. Defaults to [1024, 768]. */
  resolution?: [number, number];
  /** Display DPI. Defaults to 96. */
  dpi?: number;
}

export interface StreamStartOpts {
  /** VNC server port inside the VM. Defaults to 5900. */
  vncPort?: number;
  /** noVNC HTTP/WebSocket port inside the VM. Defaults to 6080. */
  port?: number;
  /** Require password authentication for the stream. */
  requireAuth?: boolean;
  /** Stream a specific X11 window instead of the full desktop. */
  windowId?: string;
}

export interface StreamUrlOpts {
  autoConnect?: boolean;
  viewOnly?: boolean;
  resize?: "off" | "scale" | "remote";
  authKey?: string;
}

class VNCStream {
  private _vncPort = 5900;
  private _port = 6080;
  private _password: string | undefined;
  private _running = false;

  constructor(private desktop: Desktop) {}

  get running(): boolean {
    return this._running;
  }

  /**
   * Get the authentication key for the stream.
   * Only available when `requireAuth` was set in `start()`.
   */
  getAuthKey(): string {
    if (!this._password) {
      throw new Error("No auth key — stream was started without requireAuth");
    }
    return this._password;
  }

  /**
   * Get the URL to access the remote desktop via noVNC in a browser.
   */
  getUrl(opts: StreamUrlOpts = {}): string {
    const domain = this.desktop.sandbox.getPreviewDomain(this._port);
    if (!domain) {
      throw new Error("No sandbox domain available — cannot construct stream URL");
    }
    const base = `https://${domain}/vnc.html`;
    const params = new URLSearchParams();
    if (opts.autoConnect !== false) params.set("autoconnect", "true");
    if (opts.viewOnly) params.set("view_only", "true");
    if (opts.resize) params.set("resize", opts.resize);
    if (opts.authKey) params.set("password", opts.authKey);
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  }

  /**
   * Start VNC streaming. Launches x11vnc + noVNC inside the VM.
   */
  async start(opts: StreamStartOpts = {}): Promise<void> {
    if (this._running) {
      throw new Error("Stream is already running");
    }

    this._vncPort = opts.vncPort ?? this._vncPort;
    this._port = opts.port ?? this._port;
    this._password = opts.requireAuth ? randomString() : undefined;

    const args: string[] = [];
    if (this._password) args.push("--password", this._password);
    if (opts.vncPort) args.push("--vnc-port", String(opts.vncPort));
    if (opts.port) args.push("--novnc-port", String(opts.port));
    if (opts.windowId) args.push("--window-id", opts.windowId);

    await this.desktop.exec.run(
      `/usr/local/bin/start-vnc ${args.join(" ")}`,
      { timeout: 15, env: { DISPLAY: ":99" } },
    );

    // Verify noVNC is listening
    const check = await this.desktop.exec.run(
      `for i in $(seq 1 20); do netstat -tuln 2>/dev/null | grep -q ":${this._port} " && echo ready && exit 0; sleep 0.5; done; echo timeout`,
      { timeout: 15 },
    );
    if (!check.stdout.includes("ready")) {
      throw new Error("noVNC failed to start");
    }

    this._running = true;
  }

  /** Stop VNC streaming. */
  async stop(): Promise<void> {
    await this.desktop.exec.run("/usr/local/bin/stop-vnc", {
      env: { DISPLAY: ":99" },
    });
    this._running = false;
  }
}

/**
 * Desktop sandbox with remote display, screenshots, and programmatic input.
 *
 * Wraps a standard Sandbox created with the "desktop" template and adds
 * display-specific methods (screenshot, mouse, keyboard, streaming).
 */
export class Desktop {
  /** The underlying Sandbox instance. Use this for exec, files, agent, pty, etc. */
  readonly sandbox: Sandbox;
  readonly stream: VNCStream;
  readonly display = ":99";

  private constructor(sandbox: Sandbox) {
    this.sandbox = sandbox;
    this.stream = new VNCStream(this);
  }

  // ── Delegate core sandbox properties ───────────────────────────────────

  get sandboxId(): string { return this.sandbox.sandboxId; }
  get status(): string { return this.sandbox.status; }
  get domain(): string { return this.sandbox.domain; }
  get exec(): Exec { return this.sandbox.exec; }
  get files(): Filesystem { return this.sandbox.files; }
  get agent(): Agent { return this.sandbox.agent; }
  get pty(): Pty { return this.sandbox.pty; }

  getPreviewDomain(port: number): string { return this.sandbox.getPreviewDomain(port); }
  async kill(): Promise<void> { return this.sandbox.kill(); }
  async isRunning(): Promise<boolean> { return this.sandbox.isRunning(); }
  async hibernate(): Promise<void> { return this.sandbox.hibernate(); }
  async wake(opts?: { timeout?: number }): Promise<void> { return this.sandbox.wake(opts); }
  async setTimeout(timeout: number): Promise<void> { return this.sandbox.setTimeout(timeout); }

  // ── Factory methods ────────────────────────────────────────────────────

  /**
   * Create a new desktop sandbox with a running display server.
   *
   * The VM boots with the "desktop" template which includes Xvfb, openbox,
   * x11vnc, noVNC, Chromium, xdotool, and scrot. The display environment
   * is auto-started by the worker.
   */
  static async create(opts: DesktopOpts = {}): Promise<Desktop> {
    const sandbox = await Sandbox.create({
      ...opts,
      template: opts.template ?? "desktop",
      envs: {
        DISPLAY: ":99",
        ...opts.envs,
      },
    });

    return new Desktop(sandbox);
  }

  /** Connect to an existing desktop sandbox. */
  static async connect(sandboxId: string, opts: Pick<SandboxOpts, "apiKey" | "apiUrl"> = {}): Promise<Desktop> {
    const sandbox = await Sandbox.connect(sandboxId, opts);
    return new Desktop(sandbox);
  }

  // ── Screenshot ─────────────────────────────────────────────────────────

  /** Take a screenshot and return it as a Uint8Array (PNG). */
  async screenshot(): Promise<Uint8Array> {
    const path = `/tmp/screenshot-${randomString(8)}.png`;
    await this.exec.run(`scrot --pointer ${path}`, { env: { DISPLAY: ":99" } });
    const content = await this.files.readBytes(path);
    await this.exec.run(`rm -f ${path}`);
    return content;
  }

  // ── Mouse ──────────────────────────────────────────────────────────────

  /** Move the mouse to (x, y). */
  async moveMouse(x: number, y: number): Promise<void> {
    await this.exec.run(`xdotool mousemove --sync ${x} ${y}`, { env: { DISPLAY: ":99" } });
  }

  /** Left click at the current position, or at (x, y) if provided. */
  async leftClick(x?: number, y?: number): Promise<void> {
    if (x != null && y != null) await this.moveMouse(x, y);
    await this.exec.run("xdotool click 1", { env: { DISPLAY: ":99" } });
  }

  /** Double left click. */
  async doubleClick(x?: number, y?: number): Promise<void> {
    if (x != null && y != null) await this.moveMouse(x, y);
    await this.exec.run("xdotool click --repeat 2 1", { env: { DISPLAY: ":99" } });
  }

  /** Right click. */
  async rightClick(x?: number, y?: number): Promise<void> {
    if (x != null && y != null) await this.moveMouse(x, y);
    await this.exec.run("xdotool click 3", { env: { DISPLAY: ":99" } });
  }

  /** Middle click. */
  async middleClick(x?: number, y?: number): Promise<void> {
    if (x != null && y != null) await this.moveMouse(x, y);
    await this.exec.run("xdotool click 2", { env: { DISPLAY: ":99" } });
  }

  /** Scroll the mouse wheel. */
  async scroll(direction: "up" | "down" = "down", amount = 1): Promise<void> {
    const button = direction === "up" ? "4" : "5";
    await this.exec.run(`xdotool click --repeat ${amount} ${button}`, { env: { DISPLAY: ":99" } });
  }

  /** Press and hold a mouse button. */
  async mousePress(button: "left" | "right" | "middle" = "left"): Promise<void> {
    await this.exec.run(`xdotool mousedown ${MOUSE_BUTTONS[button]}`, { env: { DISPLAY: ":99" } });
  }

  /** Release a mouse button. */
  async mouseRelease(button: "left" | "right" | "middle" = "left"): Promise<void> {
    await this.exec.run(`xdotool mouseup ${MOUSE_BUTTONS[button]}`, { env: { DISPLAY: ":99" } });
  }

  /** Drag from one position to another. */
  async drag(from: [number, number], to: [number, number]): Promise<void> {
    await this.moveMouse(from[0], from[1]);
    await this.mousePress();
    await this.moveMouse(to[0], to[1]);
    await this.mouseRelease();
  }

  /** Get the current cursor position. */
  async getCursorPosition(): Promise<{ x: number; y: number }> {
    const result = await this.exec.run("xdotool getmouselocation", { env: { DISPLAY: ":99" } });
    const match = result.stdout.match(/x:(\d+)\s+y:(\d+)/);
    if (!match) throw new Error(`Failed to parse cursor position: ${result.stdout}`);
    return { x: parseInt(match[1]), y: parseInt(match[2]) };
  }

  /** Get the screen resolution. */
  async getScreenSize(): Promise<{ width: number; height: number }> {
    const result = await this.exec.run("xrandr", { env: { DISPLAY: ":99" } });
    const match = result.stdout.match(/(\d+)x(\d+)/);
    if (!match) throw new Error(`Failed to parse screen size: ${result.stdout}`);
    return { width: parseInt(match[1]), height: parseInt(match[2]) };
  }

  // ── Keyboard ───────────────────────────────────────────────────────────

  /**
   * Type text at the current cursor position.
   * @param text - Text to type.
   * @param opts.chunkSize - Characters per xdotool call (default 25).
   * @param opts.delayMs - Delay between keystrokes in ms (default 75).
   */
  async write(text: string, opts: { chunkSize?: number; delayMs?: number } = {}): Promise<void> {
    const chunkSize = opts.chunkSize ?? 25;
    const delay = opts.delayMs ?? 75;

    for (let i = 0; i < text.length; i += chunkSize) {
      const chunk = text.slice(i, i + chunkSize);
      const escaped = "'" + chunk.replace(/'/g, "'\"'\"'") + "'";
      await this.exec.run(`xdotool type --delay ${delay} -- ${escaped}`, { env: { DISPLAY: ":99" } });
    }
  }

  /**
   * Press a key or key combination.
   * @param key - Key name (e.g. "enter", "ctrl") or array for combos (e.g. ["ctrl", "c"]).
   */
  async press(key: string | string[]): Promise<void> {
    const mapped = Array.isArray(key)
      ? key.map(mapKey).join("+")
      : mapKey(key);
    await this.exec.run(`xdotool key ${mapped}`, { env: { DISPLAY: ":99" } });
  }

  // ── Window management ──────────────────────────────────────────────────

  /** Open a file or URL in the default application. */
  async open(fileOrUrl: string): Promise<void> {
    await this.exec.run(`xdg-open ${fileOrUrl}`, { env: { DISPLAY: ":99" } });
  }

  /** Launch a .desktop application by name. */
  async launch(application: string, uri?: string): Promise<void> {
    await this.exec.run(`gtk-launch ${application} ${uri ?? ""}`, { env: { DISPLAY: ":99" } });
  }

  /** Get the currently focused window ID. */
  async getCurrentWindowId(): Promise<string> {
    const result = await this.exec.run("xdotool getwindowfocus", { env: { DISPLAY: ":99" } });
    return result.stdout.trim();
  }

  /** Get all visible window IDs for an application class. */
  async getApplicationWindows(application: string): Promise<string[]> {
    const result = await this.exec.run(
      `xdotool search --onlyvisible --class ${application}`,
      { env: { DISPLAY: ":99" } },
    );
    return result.stdout.trim().split("\n").filter(Boolean);
  }

  /** Get the title of a window by ID. */
  async getWindowTitle(windowId: string): Promise<string> {
    const result = await this.exec.run(`xdotool getwindowname ${windowId}`, { env: { DISPLAY: ":99" } });
    return result.stdout.trim();
  }

  /** Wait for a given duration (in milliseconds). */
  async wait(ms: number): Promise<void> {
    await this.exec.run(`sleep ${ms / 1000}`);
  }
}
