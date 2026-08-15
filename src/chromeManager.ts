// Owns the real, headful Chrome process that renders Instagram.
//
// The window is parked as a near-offscreen sliver rather than minimized: a
// sliver keeps rendering at full rate and accepts viewport changes, while a
// minimized window permanently stalls the screencast (verified). Audio plays
// either way.
//
// Never passes --enable-automation — navigator.webdriver must stay false.

import * as vscode from "vscode";
import { spawn, execFile, ChildProcess } from "child_process";
import * as http from "http";
import * as path from "path";
import * as fs from "fs";
import { Cdp } from "./cdp";

const BROWSERS_DARWIN = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];
const BROWSERS_LINUX = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/brave-browser",
  "/usr/bin/microsoft-edge",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];
const BROWSERS_WIN32 = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

// Ask for absurd offsets and let the OS clamp: macOS keeps a ~40px sliver
// reachable at the bottom-left corner, other platforms allow fully offscreen.
// (Negative top would clamp to the menu bar — positive top pushes DOWN.)
const PARK_POS = { left: -32000, top: 32000 };
// A window is "parked" when at most this many px of its width remain onscreen.
const PARKED_MAX_VISIBLE = 64;

// Virtual phone geometry. The width is pinned to a standard phone because
// Instagram's mobile CSS is designed for it; odd widths expose fixed-px
// breakage (one-character caption columns and the like).
const PHONE_WIDTH = 390;
// Reels is a scrolling feed, so a viewport taller than one reel's pitch lets
// the next reel bleed in. 844 is an iPhone's screen height; see PROGRESS.md
// for the measured layout law. Tunable via reelbar.reelHeight.
const DEFAULT_REEL_HEIGHT = 844;
const MIN_PHONE_HEIGHT = 400;

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("reelbar");
}

function sourceUrl(): string {
  const s = cfg().get<string>("source", "instagram");
  if (s === "ytmusic") return "https://music.youtube.com/";
  if (s === "slack") return "https://app.slack.com/";
  return cfg().get<string>("url", "https://www.instagram.com/");
}

function sourceHostname(): string {
  try {
    return new URL(sourceUrl()).hostname;
  } catch {
    return "instagram.com";
  }
}

export function findBrowser(): string | null {
  const custom = (cfg().get<string>("browserPath") || "").trim();
  if (custom) return fs.existsSync(custom) ? custom : null;
  const candidates =
    process.platform === "darwin"
      ? BROWSERS_DARWIN
      : process.platform === "win32"
        ? BROWSERS_WIN32
        : BROWSERS_LINUX;
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function httpGetJson(url: string, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

function readPortFile(profileDir: string): { port: number; wsPath: string } | null {
  try {
    const raw = fs.readFileSync(path.join(profileDir, "DevToolsActivePort"), "utf8");
    const lines = raw.split("\n").map((l) => l.trim());
    const port = parseInt(lines[0], 10);
    if (!Number.isFinite(port) || port <= 0 || !lines[1]) return null;
    return { port, wsPath: lines[1] };
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface ChromeEvents {
  onGone: () => void;
}

export class ChromeManager {
  private context: vscode.ExtensionContext;
  private events: ChromeEvents;
  private proc: ChildProcess | null = null;
  private cdp: Cdp | null = null;
  private windowId: number | null = null;
  private targetId: string | null = null;
  private parkTimer: ReturnType<typeof setInterval> | null = null;
  private shown = false; // window intentionally onscreen for login
  private disposed = false;
  // Deduped on the COMPUTED target, not raw sidebar px: in phone mode many
  // sidebar sizes map to the same emulated viewport.
  private lastAppliedViewport: { width: number; height: number; mobile: boolean } | null =
    null;
  // Pinned per session: phone metrics with a desktop UA is a broken layout.
  private sessionMobile = false;
  private minimizedPark = false; // sliver park failed; window is minimized

  constructor(context: vscode.ExtensionContext, events: ChromeEvents) {
    this.context = context;
    this.events = events;
  }

  get connection(): Cdp | null {
    return this.cdp;
  }

  get pageTargetId(): string | null {
    return this.targetId;
  }

  get isShown(): boolean {
    return this.shown;
  }

  get isConnected(): boolean {
    return !!this.cdp;
  }

  // True when the sliver park failed and the window sits minimized. A cast
  // must NEVER be stopped-and-restarted in this state (a cast started while
  // minimized produces zero frames, permanently).
  get parkedByMinimize(): boolean {
    return this.minimizedPark;
  }

  // Called once per session from setupSession, alongside the UA override.
  setSessionMobile(mobile: boolean): void {
    this.sessionMobile = mobile;
  }

  private get profileDir(): string {
    return path.join(this.context.globalStorageUri.fsPath, "profile");
  }

  // Connect to a live Chrome on our profile, or spawn one. Returns the
  // page sessionId ready for screencast/input.
  async connectOrLaunch(): Promise<{ cdp: Cdp; sessionId: string }> {
    if (this.cdp && this.targetId) {
      const sessionId = await this.attachPage();
      return { cdp: this.cdp, sessionId };
    }

    fs.mkdirSync(this.profileDir, { recursive: true });

    let wsUrl = await this.liveEndpoint();
    if (!wsUrl) {
      wsUrl = await this.spawnChrome();
    }

    const cdp = await Cdp.connect(wsUrl);
    this.cdp = cdp;
    cdp.onClose(() => {
      this.cdp = null;
      this.windowId = null;
      this.targetId = null;
      this.stopParkPatrol();
      if (!this.disposed) this.events.onGone();
    });

    const sessionId = await this.attachPage();
    // NOTE: the window is NOT parked here. A screencast started while the
    // window is minimized produces no frames (verified on macOS), so the
    // caller must start the screencast first, then call park().
    return { cdp, sessionId };
  }

  // Park the window and keep it parked (display changes can un-park it).
  async park(): Promise<void> {
    await this.parkWindow();
    this.startParkPatrol();
  }

  // ---- endpoint discovery -------------------------------------------------

  private async liveEndpoint(): Promise<string | null> {
    const pf = readPortFile(this.profileDir);
    if (!pf) return null;
    try {
      await httpGetJson(`http://127.0.0.1:${pf.port}/json/version`, 800);
      return `ws://127.0.0.1:${pf.port}${pf.wsPath}`;
    } catch {
      return null;
    }
  }

  private async spawnChrome(): Promise<string> {
    const bin = findBrowser();
    if (!bin) {
      throw new Error(
        "No Chromium browser found. Set reelbar.browserPath to a Chrome/Brave/Edge binary."
      );
    }
    const portFilePath = path.join(this.profileDir, "DevToolsActivePort");
    try {
      fs.unlinkSync(portFilePath);
    } catch {
      /* ignore */
    }

    const url = sourceUrl();
    const args = [
      "--remote-debugging-port=0",
      `--user-data-dir=${this.profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=Translate",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      "--autoplay-policy=no-user-gesture-required",
      "--disable-session-crashed-bubble",
      "--hide-crash-restore-bubble",
      "--window-size=480,900",
      url,
    ];

    this.proc = spawn(bin, args, { stdio: "ignore" });
    const proc = this.proc;
    proc.on("exit", () => {
      if (this.proc === proc) this.proc = null;
    });

    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const pf = readPortFile(this.profileDir);
      if (pf) return `ws://127.0.0.1:${pf.port}${pf.wsPath}`;
      if (proc.exitCode !== null) {
        // Process died before publishing a port: almost certainly the profile
        // SingletonLock is held by a Chrome without a debug port (old window
        // mode, or a manual launch).
        throw new SingletonLockError(this.profileDir);
      }
      await sleep(100);
    }
    throw new Error("Chrome did not publish a DevTools endpoint within 15s.");
  }

  // Kill whatever Chrome holds the profile lock, then relaunch.
  async forceRelaunch(): Promise<{ cdp: Cdp; sessionId: string }> {
    await new Promise<void>((resolve) => {
      execFile("pkill", ["-f", `user-data-dir=${this.profileDir}`], () => resolve());
    });
    await sleep(1000);
    return this.connectOrLaunch();
  }

  // ---- page target --------------------------------------------------------

  private async attachPage(): Promise<string> {
    if (!this.cdp) throw new Error("Not connected");
    // The page may live in a different window than last time (e.g. the user
    // closed the window and we recreated the tab) — never trust a cached id,
    // or park() will minimize a dead window while the new one stays visible.
    this.windowId = null;
    this.lastAppliedViewport = null; // new window/session: no override applied yet
    const { targetInfos } = await this.cdp.send("Target.getTargets");
    const hostname = sourceHostname();
    let page = (targetInfos as any[]).find(
      (t) => t.type === "page" && t.url.includes(hostname)
    );
    if (!page) {
      page = (targetInfos as any[]).find(
        (t) => t.type === "page" && !t.url.startsWith("devtools://")
      );
    }
    let targetId: string;
    if (page) {
      targetId = page.targetId;
    } else {
      const created = await this.cdp.send("Target.createTarget", { url: sourceUrl() });
      targetId = created.targetId;
    }
    this.targetId = targetId;
    const { sessionId } = await this.cdp.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    return sessionId;
  }

  async recreatePage(): Promise<string> {
    this.targetId = null;
    return this.attachPage();
  }

  // ---- window parking / showing ------------------------------------------

  private async resolveWindowId(): Promise<number | null> {
    if (!this.cdp || !this.targetId) return null;
    if (this.windowId !== null) return this.windowId;
    try {
      const { windowId } = await this.cdp.send("Browser.getWindowForTarget", {
        targetId: this.targetId,
      });
      this.windowId = windowId;
      return windowId;
    } catch {
      return null;
    }
  }

  async parkWindow(): Promise<void> {
    if (!this.cdp) return;
    const windowId = await this.resolveWindowId();
    if (windowId === null) return;
    this.shown = false;
    try {
      // Must leave any special windowState (minimized from an old session,
      // maximized by the user during login) before moving.
      await this.cdp.send("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "normal" },
      });
      await this.cdp.send("Browser.setWindowBounds", {
        windowId,
        bounds: { left: PARK_POS.left, top: PARK_POS.top },
      });
      const { bounds } = await this.cdp.send("Browser.getWindowBounds", { windowId });
      if (bounds.left + bounds.width > PARKED_MAX_VISIBLE) {
        // The OS refused to move it near-offscreen (unexpected — macOS clamps
        // to a ~40px sliver). Minimizing still hides it and keeps audio, at
        // the cost of resizes not applying until the next unpark — and the
        // cast must never be stopped while in this state (see parkedByMinimize).
        await this.minimize(windowId);
        this.minimizedPark = true;
        this.lastAppliedViewport = null; // overrides stall on minimized windows
      } else {
        this.minimizedPark = false;
      }
    } catch {
      /* window may be mid-close; patrol will retry */
    }
  }

  private async minimize(windowId: number): Promise<void> {
    try {
      await this.cdp!.send("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "minimized" },
      });
    } catch {
      /* ignore */
    }
  }

  async showWindow(sessionId: string): Promise<void> {
    if (!this.cdp) return;
    const windowId = await this.resolveWindowId();
    if (windowId === null) return;
    this.shown = true;
    this.minimizedPark = false;
    this.stopParkPatrol();
    try {
      await this.cdp.send("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "normal" },
      });
      await this.cdp.send("Browser.setWindowBounds", {
        windowId,
        bounds: { left: 200, top: 100, width: 1000, height: 800 },
      });
      await this.cdp.send("Page.bringToFront", {}, sessionId);
    } catch {
      /* ignore */
    }
    this.bringAppToFront();
  }

  async hideWindow(): Promise<void> {
    await this.park();
  }

  private bringAppToFront(): void {
    if (process.platform !== "darwin") return;
    const pid = this.proc?.pid;
    const script = pid
      ? `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`
      : null;
    if (script) {
      execFile("osascript", ["-e", script], () => {});
    } else {
      // Attached to a Chrome we didn't spawn: find its pid via the profile dir.
      execFile("pgrep", ["-f", `user-data-dir=${this.profileDir}`], (err, out) => {
        const found = parseInt((out || "").split("\n")[0], 10);
        if (!err && Number.isFinite(found)) {
          execFile(
            "osascript",
            ["-e", `tell application "System Events" to set frontmost of (first process whose unix id is ${found}) to true`],
            () => {}
          );
        }
      });
    }
  }

  // macOS display changes (sleep, monitor plug) can shove parked windows back
  // onscreen; re-park periodically while we're supposed to be hidden.
  private startParkPatrol(): void {
    this.stopParkPatrol();
    this.parkTimer = setInterval(() => {
      if (this.shown || !this.cdp) return;
      void (async () => {
        const windowId = await this.resolveWindowId();
        if (windowId === null || !this.cdp) return;
        try {
          const { bounds } = await this.cdp.send("Browser.getWindowBounds", { windowId });
          const parked =
            bounds.windowState === "minimized" ||
            bounds.left + bounds.width <= PARKED_MAX_VISIBLE;
          if (!parked) await this.parkWindow();
        } catch {
          /* ignore */
        }
      })();
    }, 30000);
  }

  private stopParkPatrol(): void {
    if (this.parkTimer) {
      clearInterval(this.parkTimer);
      this.parkTimer = null;
    }
  }

  // ---- resize -------------------------------------------------------------

  // Make the page's layout viewport match the sidebar via viewport emulation.
  // A real-window resize can't do this: sidebars are routinely TALLER than
  // the screen allows a window to be, which letterboxes the stream. Emulation
  // has no screen limit. It is safe ONLY because sliver-parked windows stay
  // windowState "normal" — the same override on a MINIMIZED window
  // permanently stalls the screencast (verified empirically), which is why
  // this method restores "normal" first and park() never minimizes except as
  // a last-resort fallback.
  // Returns true when an override was actually sent (false = deduped, or the
  // window is currently shown for login).
  async setViewportSize(sessionId: string, cssW: number, cssH: number): Promise<boolean> {
    if (!this.cdp) return false;
    // While shown for login the window must stay a normal, un-emulated
    // browser (clearViewportOverride ran at show time) — never touch it.
    if (this.shown) return false;
    const { width, height, mobile } = this.emulationTarget(cssW, cssH);
    // Every override reflows Instagram's (heavy) layout, so never re-send an
    // identical one: sidebar drags in phone mode collapse to the same 390x844
    // target for a wide range of sizes.
    const last = this.lastAppliedViewport;
    if (last && last.width === width && last.height === height && last.mobile === mobile) {
      return false;
    }
    try {
      const windowId = await this.resolveWindowId();
      if (windowId !== null) {
        await this.cdp.send("Browser.setWindowBounds", {
          windowId,
          bounds: { windowState: "normal" },
        });
      }
      await this.cdp.send(
        "Emulation.setDeviceMetricsOverride",
        {
          width,
          height,
          // Phone mode captures at 2x so the 390px-wide stream stays sharp
          // when the canvas scales it up; 0 = device's own scale factor.
          deviceScaleFactor: mobile ? 2 : 0,
          mobile,
        },
        sessionId
      );
      this.lastAppliedViewport = { width, height, mobile };
      // The "normal" guard above un-minimizes a minimize-parked window, which
      // would leave it sitting onscreen. Re-park it (the sliver may work now;
      // if not, it minimizes again — safe, the override already landed).
      if (this.minimizedPark) await this.parkWindow();
      return true;
    } catch {
      return false;
    }
  }

  // The emulated viewport for a given sidebar size. Split out so the resize
  // pump can dedupe on the computed target rather than raw sidebar pixels.
  private emulationTarget(
    cssW: number,
    cssH: number
  ): { width: number; height: number; mobile: boolean } {
    const w = Math.max(100, Math.round(cssW));
    const h = Math.max(100, Math.round(cssH));
    const mobile = this.sessionMobile;
    const width = mobile ? PHONE_WIDTH : w;
    // Height follows the sidebar's aspect so the scaled stream fills the view,
    // but is capped (see DEFAULT_REEL_HEIGHT): without a cap, narrowing the
    // sidebar lowers the scale factor, which fits MORE page into the same box
    // and starts revealing the next reel. Past the cap the stream letterboxes
    // slightly — one reel, centered, which is the tradeoff we want.
    const cap = Math.max(
      MIN_PHONE_HEIGHT,
      Math.round(cfg().get<number>("reelHeight", DEFAULT_REEL_HEIGHT))
    );
    const aspectHeight = Math.max(MIN_PHONE_HEIGHT, Math.round((PHONE_WIDTH * h) / w));
    const height = mobile ? Math.min(cap, aspectHeight) : h;
    return { width, height, mobile };
  }

  // The real window must look normal when shown for login — drop any
  // viewport emulation.
  async clearViewportOverride(sessionId: string): Promise<void> {
    this.lastAppliedViewport = null;
    if (!this.cdp) return;
    await this.cdp
      .send("Emulation.clearDeviceMetricsOverride", {}, sessionId)
      .catch(() => {});
  }

  // ---- teardown -----------------------------------------------------------

  async dispose(): Promise<void> {
    this.disposed = true;
    this.stopParkPatrol();
    const cdp = this.cdp;
    this.cdp = null;
    if (cdp) {
      try {
        await Promise.race([cdp.send("Browser.close"), sleep(1500)]);
      } catch {
        /* ignore */
      }
      cdp.close();
    }
    const proc = this.proc;
    this.proc = null;
    if (proc && proc.exitCode === null && !proc.killed) {
      // Give Browser.close a moment to land before the hammer.
      await sleep(500);
      if (proc.exitCode === null && !proc.killed) {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }
  }
}

export class SingletonLockError extends Error {
  profileDir: string;
  constructor(profileDir: string) {
    super(
      "Another Chrome window is already using the Reelbar profile (probably the old window mode)."
    );
    this.profileDir = profileDir;
  }
}
