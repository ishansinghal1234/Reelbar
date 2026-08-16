// The sidebar view: owns the CDP page session, streams screencast frames to
// the webview canvas, and forwards webview input back through CDP.

import * as vscode from "vscode";
import { ChromeManager, SingletonLockError } from "./chromeManager";
import { Cdp } from "./cdp";

const LOGIN_URL_INSTAGRAM_RE =
  /\/accounts\/login|\/challenge|\/checkpoint|\/two_factor|\/auth_platform|\/accounts\/suspended/;
const LOGIN_URL_YTMUSIC_RE =
  /accounts\.google\.com\/(signin|ServiceLogin|o\/oauth2)|myaccount\.google\.com/;
const LOGIN_URL_SLACK_RE =
  /slack\.com\/(sign_?in|workspace-signin|intl\/[^/]+\/sign_?in|get-started)|app\.slack\.com\/(auth|[^/]+\/auth)/;

// Virtual key codes for the non-printable keys Instagram cares about.
const VK: Record<string, number> = {
  Enter: 13,
  Backspace: 8,
  Tab: 9,
  Escape: 27,
  Space: 32,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
  PageUp: 33,
  PageDown: 34,
  Home: 36,
  End: 35,
};

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("reelbar");
}


// Bail out of a page action when the user is actually typing (comment box,
// search field) so Space still types a space and arrows still move the caret.
const TYPING_GUARD = `
  const a = document.activeElement;
  if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable))
    return "typing";`;

// Instagram binds nothing to the arrow keys, so a press falls through to the
// browser's ~40px scroll — about 20 presses per reel. Step a whole reel here.
export function reelStepJs(dir: 1 | -1): string {
  return `(() => {${TYPING_GUARD}
  const vids = [...document.querySelectorAll("video")];
  if (!vids.length) return "novideo";
  let s = vids[0];
  while (s && !(s.scrollHeight > s.clientHeight + 20 &&
                /auto|scroll/.test(getComputedStyle(s).overflowY) &&
                s.clientHeight > 200)) s = s.parentElement;
  s = s || document.scrollingElement;
  const tops = vids.map(v => v.getBoundingClientRect().top).sort((x, y) => x - y);
  const diffs = [];
  for (let i = 1; i < tops.length; i++) diffs.push(Math.round(tops[i] - tops[i - 1]));
  diffs.sort((x, y) => x - y);
  // Measured, never assumed: 799 on the phone layout, 749 on desktop.
  const pitch = diffs.length ? diffs[diffs.length >> 1] : s.clientHeight;
  if (!pitch) return "nopitch";
  // Anchor to the nearest reel edge so a nudged feed re-aligns instead of drifting.
  const nearest = tops.reduce((a, b) => (Math.abs(b) < Math.abs(a) ? b : a), Infinity);
  const flush = s.scrollTop + (isFinite(nearest) ? nearest : 0);
  // Build on the pending target, or a fast second press just re-completes the
  // scroll already running instead of advancing.
  const prev = window.__reelbarReelTarget;
  const base = prev && Date.now() - prev.at < 800 ? prev.top : flush;
  const max = s.scrollHeight - s.clientHeight;
  const top = Math.max(0, Math.min(max, base + ${dir} * pitch));
  window.__reelbarReelTarget = { top: top, at: Date.now() };
  s.scrollTo({ top: top, behavior: "smooth" });
  return "snap";
})()`;
}

// Instagram's mobile web does not pause on tap (verified), so drive the
// element directly — whichever reel is most centred.
export const TOGGLE_PLAY_JS = `(() => {${TYPING_GUARD}
  const mid = innerHeight / 2;
  let best = null, bestD = Infinity;
  for (const v of document.querySelectorAll("video")) {
    const r = v.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) continue;
    const d = Math.abs((r.top + r.bottom) / 2 - mid);
    if (d < bestD) { bestD = d; best = v; }
  }
  if (!best) return "novideo";
  if (best.paused) { best.play(); return "play"; }
  best.pause();
  return "pause";
})()`;

// Just the typing check, for panels where the page owns play/pause and we
// only need to know whether Space belongs to a focused text field.
export const IS_TYPING_JS = `(() => {${TYPING_GUARD}
  return "page";
})()`;

interface ViewDims {
  cssW: number;
  cssH: number;
  dpr: number;
}

// Each viewport override reflows Instagram's heavy layout, so pace them. Every
// apply reads the newest size at dispatch time, so the last tick of a drag
// carries the final size and no separate settle delay is needed.
const RESIZE_THROTTLE_MS = 250;
// A hidden view reports a collapsed body; applying that would reflow the page.
const MIN_SANE_DIM = 50;

export class ReelViewProvider implements vscode.WebviewViewProvider {
  readonly viewId: string;
  readonly source: string;

  private context: vscode.ExtensionContext;
  private chrome: ChromeManager;
  private view: vscode.WebviewView | null = null;
  private sessionId: string | null = null;
  private cdp: Cdp | null = null;
  private dims: ViewDims = { cssW: 440, cssH: 800, dpr: 2 };
  private lastFrameMeta = { deviceWidth: 440, deviceHeight: 800 };
  private casting = false;
  private connecting = false;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private lastResizeApplyAt = 0;
  private resizeInFlight = false;
  private resizeQueued = false;
  private mutedByUs = false;
  private navKeys = new Set<string>(); // arrow keydowns we consumed, awaiting keyup
  private disposables: Array<() => void> = [];

  constructor(context: vscode.ExtensionContext, viewId: string, source: string) {
    this.context = context;
    this.viewId = viewId;
    this.source = source;
    this.chrome = this.makeChrome();
  }

  private makeChrome(): ChromeManager {
    // Instagram keeps the pre-multi-panel "profile" subdir so existing users
    // stay logged in across the upgrade; new panels get their own.
    const profileSubdir = this.source === "instagram" ? "profile" : `profile-${this.source}`;
    return new ChromeManager(
      this.context,
      { onGone: () => this.onChromeGone() },
      profileSubdir,
      this.sourceUrl()
    );
  }

  private sourceUrl(): string {
    if (this.source === "ytmusic") return "https://music.youtube.com/";
    if (this.source === "slack") return "https://app.slack.com/";
    return cfg().get<string>("url", "https://www.instagram.com/");
  }

  get chromeManager(): ChromeManager {
    return this.chrome;
  }

  get isVisible(): boolean {
    return !!this.view?.visible;
  }

  // ---- WebviewViewProvider ------------------------------------------------

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    view.webview.html = this.html(view.webview);

    view.webview.onDidReceiveMessage((m) => void this.onWebviewMessage(m));
    view.onDidChangeVisibility(() => void this.onVisibilityChanged());
    view.onDidDispose(() => {
      this.view = null;
      void this.stopScreencast();
    });
  }

  private html(webview: vscode.Webview): string {
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const js = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "main.js")
    );
    const css = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "main.css")
    );
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}">
</head>
<body>
<canvas id="screen" tabindex="0"></canvas>
<div id="overlay" hidden>
  <p id="overlay-msg"></p>
  <button id="overlay-btn"></button>
</div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }

  // ---- webview messages ---------------------------------------------------

  private async onWebviewMessage(m: any): Promise<void> {
    switch (m?.type) {
      case "ready":
        this.dims = { cssW: m.cssW || 440, cssH: m.cssH || 800, dpr: m.dpr || 2 };
        await this.connect();
        break;
      case "resize":
        // A hidden view reports a collapsed body; adopting those dims would
        // reflow the live page down to a stub and back again on re-show.
        if (!this.view?.visible) break;
        if (!(m.cssW >= MIN_SANE_DIM) || !(m.cssH >= MIN_SANE_DIM)) break;
        this.dims = { cssW: m.cssW, cssH: m.cssH, dpr: m.dpr };
        this.scheduleResize();
        break;
      case "mouse":
        await this.dispatchMouse(m);
        break;
      case "key":
        await this.dispatchKey(m);
        break;
      case "text":
        if (this.cdp && this.sessionId && typeof m.text === "string") {
          if (m.text === " ") {
            if (this.source === "instagram") {
              // Instagram: toggle play/pause via the video element directly.
              if ((await this.pageAction(TOGGLE_PLAY_JS)) !== "typing") break;
            } else if ((await this.pageAction(IS_TYPING_JS)) !== "typing") {
              // YT Music and Slack bind space via keydown — dispatch as a real
              // key event instead of inserting a text character. When the
              // focus is in a text field (search box, message composer), fall
              // through to insertText so the space actually types.
              const spaceKey = { key: " ", code: "Space", windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 };
              await this.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...spaceKey }, this.sessionId).catch(() => {});
              await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...spaceKey }, this.sessionId).catch(() => {});
              break;
            }
          }
          await this.cdp
            .send("Input.insertText", { text: m.text }, this.sessionId)
            .catch(() => {});
        }
        break;
      case "showWindow":
        await this.showBrowserWindow();
        break;
      case "hideWindow":
        await this.hideBrowserWindow();
        break;
      case "reconnect":
        await this.connect();
        break;
    }
  }

  // ---- connection & screencast -------------------------------------------

  async connect(): Promise<void> {
    if (this.connecting) return;
    this.connecting = true;
    this.postState("connecting", "Starting browser…");
    try {
      const { cdp, sessionId } = await this.chrome.connectOrLaunch();
      this.cdp = cdp;
      this.sessionId = sessionId;
      await this.goLive();
    } catch (e: any) {
      if (e instanceof SingletonLockError) {
        this.postState("error", "Another Chrome window is using the Reelbar profile.");
        const pick = await vscode.window.showErrorMessage(
          "Reelbar: another Chrome window is using the profile (old window mode?).",
          "Close it and retry"
        );
        if (pick === "Close it and retry") {
          try {
            const { cdp, sessionId } = await this.chrome.forceRelaunch();
            this.cdp = cdp;
            this.sessionId = sessionId;
            await this.goLive();
          } catch (e2: any) {
            this.postState("error", String(e2?.message || e2));
          }
        }
      } else {
        this.postState("error", String(e?.message || e));
      }
    } finally {
      this.connecting = false;
    }
  }

  // Order matters: the screencast must be running BEFORE the window is
  // parked (a cast started while minimized never produces frames), and it
  // must never be stopped while parked (a restart would be equally dead).
  private async goLive(): Promise<void> {
    await this.setupSession();
    this.postState("live");
    await this.startScreencast();
    await this.chrome.park();
    this.scheduleResize(); // fit the page to the sidebar's actual size
    // The view can be switched away from while the browser is still starting;
    // nothing would stop the stream until the next visibility change.
    if (!this.view?.visible && !this.chrome.parkedByMinimize) {
      await this.stopScreencast();
    }
  }

  private async setupSession(): Promise<void> {
    if (!this.cdp || !this.sessionId) return;
    const cdp = this.cdp;
    const sessionId = this.sessionId;

    for (const d of this.disposables) d();
    this.disposables = [];

    await cdp.send("Page.enable", {}, sessionId);

    // Slack: three-layer defence so workspace navigation stays in the panel.
    if (this.source === "slack") {
      const slackScript = `(function(){
        if (window.__reelbarSlack) return;
        window.__reelbarSlack = true;
        // 1. Intercept window.open — Slack calls this for workspace navigation
        const _open = window.open;
        window.open = function(url) {
          if (typeof url === "string") {
            if (url.startsWith("slack://")) return null;
            if (url.startsWith("https://app.slack.com/")) { location.href = url; return null; }
          }
          return _open.apply(this, arguments);
        };
        // 2. Intercept <a target="_blank"> clicks
        document.addEventListener("click", function(e) {
          const a = e.target && e.target.closest && e.target.closest("a");
          if (a && a.target === "_blank" && a.href && a.href.startsWith("https://app.slack.com/")) {
            e.preventDefault(); e.stopPropagation(); location.href = a.href;
          }
        }, true);
      })();`;

      // Inject into the CURRENT page (addScriptToEvaluateOnNewDocument only
      // runs on future page loads — the workspace picker is already loaded).
      await cdp.send("Runtime.evaluate", {
        expression: slackScript, returnByValue: false,
      }, sessionId).catch(() => {});

      // Also inject into every future page navigation.
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: slackScript,
      }, sessionId).catch(() => {});

      // 3. Browser-level fallback: if a new app.slack.com/client tab is created
      // anyway (e.g. via browser-internal navigation we can't intercept in JS),
      // pull its URL into our main tab and close the orphan.
      await cdp.send("Target.setDiscoverTargets", { discover: true }).catch(() => {});
      const mainTargetId = this.chrome.pageTargetId;
      const pullNewSlackTab = async (info: any) => {
        if (!info || info.type !== "page" || info.targetId === mainTargetId) return;
        if (!info.url.startsWith("https://app.slack.com/client/")) return;
        const sid = this.sessionId;
        if (!sid) return;
        await cdp.send("Page.navigate", { url: info.url }, sid).catch(() => {});
        await cdp.send("Target.closeTarget", { targetId: info.targetId }).catch(() => {});
      };
      this.disposables.push(
        cdp.on("Target.targetCreated",     (p) => void pullNewSlackTab(p?.targetInfo))
      );
      this.disposables.push(
        cdp.on("Target.targetInfoChanged", (p) => void pullNewSlackTab(p?.targetInfo))
      );
    }

    // The page must believe it's focused while parked offscreen, or videos
    // pause and hover UI never appears.
    await cdp
      .send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId)
      .catch(() => {});
    // Optional phone persona: with an iPhone UA (kept consistent for the
    // whole session — flip-flopping mid-session would look odd) Instagram
    // serves its mobile UI, where reels fill the viewport edge to edge.
    // Pinned here so a mid-session config toggle can't pair phone metrics
    // with a desktop UA (or vice versa) on the next resize.
    // YT Music and Slack are desktop-first; mobileUI is Instagram-only.
    const wantMobile = this.source === "instagram" && cfg().get<boolean>("mobileUI", false);
    this.chrome.setSessionMobile(wantMobile);
    if (wantMobile) {
      const ua = {
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
        platform: "iPhone",
      };
      // Client Hints headers (Sec-CH-UA-*) would otherwise still say
      // "Chromium on macOS" and contradict the iPhone UA string.
      const withMeta = {
        ...ua,
        userAgentMetadata: {
          platform: "iOS",
          platformVersion: "17.5",
          architecture: "",
          model: "iPhone",
          mobile: true,
          brands: [],
        },
      };
      const ok = await cdp
        .send("Emulation.setUserAgentOverride", withMeta, sessionId)
        .then(() => true)
        .catch(() => false);
      if (!ok) {
        await cdp.send("Emulation.setUserAgentOverride", ua, sessionId).catch(() => {});
      }
    }

    this.disposables.push(
      cdp.on("Page.screencastFrame", (params, sid) => {
        if (sid !== this.sessionId) return;
        // Ack immediately so Chrome's frame producer never stalls; the
        // webview drops stale frames itself (latest-wins).
        void cdp
          .send("Page.screencastFrameAck", { sessionId: params.sessionId }, sessionId)
          .catch(() => {});
        // lastFrameMeta must only ever come from a real frame: input mapping
        // targets what is currently ON SCREEN, which during a resize is still
        // the old viewport until the first re-laid-out frame arrives.
        const meta = params.metadata || {};
        if (meta.deviceWidth && meta.deviceHeight) {
          this.lastFrameMeta = {
            deviceWidth: meta.deviceWidth,
            deviceHeight: meta.deviceHeight,
          };
        }
        // Ship raw JPEG bytes rather than base64: a third less payload and no
        // atob/data-URL work in the webview. (Webview views have supported
        // typed arrays over postMessage since VS Code 1.66; we require 1.80.)
        this.view?.webview.postMessage({
          type: "frame",
          data: new Uint8Array(Buffer.from(params.data, "base64")),
        });
      }),

      cdp.on("Page.frameNavigated", (params, sid) => {
        if (sid !== this.sessionId) return;
        const frame = params.frame;
        if (frame?.parentId) return; // main frame only
        const url: string = frame?.url || "";
        const loginRe = this.source === "ytmusic" ? LOGIN_URL_YTMUSIC_RE
          : this.source === "slack" ? LOGIN_URL_SLACK_RE
          : LOGIN_URL_INSTAGRAM_RE;
        if (loginRe.test(url)) {
          const detail = this.source === "ytmusic"
            ? "YouTube Music wants you to log in with your Google account. Do it in a real browser window — it only takes once."
            : this.source === "slack"
            ? "Slack wants you to sign in to your workspace. Do it in a real browser window — it only takes once."
            : "Instagram wants you to log in or verify. Do it in a real browser window — it only takes once.";
          this.postState("loginNeeded", detail);
        } else if (!this.chrome.isShown) {
          this.postState("live");
        }
      }),

      cdp.on("Target.targetCrashed", () => this.onChromeGone()),
      cdp.on("Target.detachedFromTarget", (params) => {
        if (params?.sessionId === this.sessionId) {
          this.sessionId = null;
          void this.reattachPage();
        }
      })
    );
  }

  private async reattachPage(): Promise<void> {
    if (!this.cdp) return;
    try {
      this.sessionId = await this.chrome.recreatePage();
      await this.goLive();
    } catch {
      this.onChromeGone();
    }
  }

  private async startScreencast(): Promise<void> {
    if (!this.cdp || !this.sessionId || this.casting) return;
    const q = Math.min(100, Math.max(30, cfg().get<number>("quality", 70)));
    this.casting = true;
    // Generous fixed caps: the cast runs continuously across sidebar resizes
    // (frames track the emulated viewport), so the caps only exist to bound
    // encode cost on huge displays.
    await this.cdp
      .send(
        "Page.startScreencast",
        {
          format: "jpeg",
          quality: q,
          maxWidth: 2048,
          maxHeight: 2560,
          everyNthFrame: 1,
        },
        this.sessionId
      )
      .catch(() => {
        this.casting = false;
      });
  }

  private async stopScreencast(): Promise<void> {
    if (!this.cdp || !this.sessionId || !this.casting) return;
    this.casting = false;
    await this.cdp.send("Page.stopScreencast", {}, this.sessionId).catch(() => {});
  }

  private onChromeGone(): void {
    this.cdp = null;
    this.sessionId = null;
    this.casting = false;
    this.postState("chromeDead");
  }

  // ---- visibility ---------------------------------------------------------

  // Nobody is looking at the frames while the view is hidden, so stop
  // encoding them — that is the whole cost of the stream. Audio is untouched
  // (reels keep playing; podcast mode still works), and a sliver-parked
  // window restarts a cast cleanly, which is smoke-verified.
  private async onVisibilityChanged(): Promise<void> {
    if (!this.view) return;
    if (this.view.visible) {
      // Only undo OUR mute — the user may have muted the reel in Instagram's
      // own UI, and that must survive hiding and re-showing the view.
      if (this.mutedByUs) {
        this.mutedByUs = false;
        await this.setPageMuted(false);
      }
      // Re-fit before the stream resumes so the very first frame back is
      // already the right size (resizes were ignored while hidden).
      await this.applyResize();
      // While the window is shown for login the cast is stopped on purpose.
      if (!this.chrome.isShown) await this.startScreencast();
    } else {
      if (cfg().get<boolean>("muteWhenHidden", false)) {
        this.mutedByUs = true;
        await this.setPageMuted(true);
      }
      // A cast started on a MINIMIZED window never produces frames, so on the
      // machines where the sliver park failed we simply never stop it.
      if (!this.chrome.isShown && !this.chrome.parkedByMinimize) {
        await this.stopScreencast();
      }
    }
  }

  private async setPageMuted(muted: boolean): Promise<void> {
    if (!this.cdp || !this.sessionId) return;
    await this.cdp
      .send(
        "Runtime.evaluate",
        {
          expression: `document.querySelectorAll("video,audio").forEach(v => { v.muted = ${muted}; })`,
          returnByValue: true,
        },
        this.sessionId
      )
      .catch(() => {});
  }

  // ---- input --------------------------------------------------------------

  private toPageCoords(nx: number, ny: number): { x: number; y: number } {
    return {
      x: Math.max(0, nx * this.lastFrameMeta.deviceWidth),
      y: Math.max(0, ny * this.lastFrameMeta.deviceHeight),
    };
  }

  private async dispatchMouse(m: any): Promise<void> {
    if (!this.cdp || !this.sessionId) return;
    const { x, y } = this.toPageCoords(m.nx ?? 0, m.ny ?? 0);
    const sessionId = this.sessionId;
    const buttonName = m.button === 2 ? "right" : m.button === 1 ? "middle" : "left";
    try {
      switch (m.kind) {
        case "down":
          await this.cdp.send(
            "Input.dispatchMouseEvent",
            {
              type: "mousePressed",
              x,
              y,
              button: buttonName,
              clickCount: m.clickCount || 1,
              modifiers: m.mods || 0,
            },
            sessionId
          );
          break;
        case "up":
          await this.cdp.send(
            "Input.dispatchMouseEvent",
            {
              type: "mouseReleased",
              x,
              y,
              button: buttonName,
              clickCount: m.clickCount || 1,
              modifiers: m.mods || 0,
            },
            sessionId
          );
          break;
        case "move":
          await this.cdp.send(
            "Input.dispatchMouseEvent",
            { type: "mouseMoved", x, y },
            sessionId
          );
          break;
        case "wheel":
          // CDP wheel deltas follow the DOM sign convention (positive = down)
          // — verified empirically; do NOT negate.
          await this.cdp.send(
            "Input.dispatchMouseEvent",
            { type: "mouseWheel", x, y, deltaX: m.dx || 0, deltaY: m.dy || 0 },
            sessionId
          );
          break;
      }
    } catch {
      /* dropped input is not fatal */
    }
  }

  // Runs a small expression in the page and returns its string result.
  private async pageAction(expression: string): Promise<string | null> {
    if (!this.cdp || !this.sessionId) return null;
    try {
      const r = await this.cdp.send(
        "Runtime.evaluate",
        { expression, returnByValue: true },
        this.sessionId
      );
      return r?.result?.value ?? null;
    } catch {
      return null;
    }
  }

  private async dispatchKey(m: any): Promise<void> {
    if (!this.cdp || !this.sessionId) return;
    const code = m.code || m.key;
    // Reel scroll — Instagram only: the page binds nothing to arrows so we
    // step a full reel. YT Music handles arrows natively (seek / volume).
    if (this.source === "instagram" && (code === "ArrowDown" || code === "ArrowUp")) {
      if (this.navKeys.has(code)) {
        if (m.kind === "up") this.navKeys.delete(code);
        return; // swallow the matching keyup of a keydown we consumed
      }
      if (m.kind !== "up" && !m.mods) {
        const r = await this.pageAction(reelStepJs(code === "ArrowDown" ? 1 : -1));
        if (r && r !== "typing") {
          this.navKeys.add(code);
          return;
        }
      }
    }
    const vk = VK[m.code] ?? VK[m.key];
    const params: any = {
      type: m.kind === "up" ? "keyUp" : "keyDown",
      key: m.key,
      code: m.code,
      modifiers: m.mods || 0,
    };
    if (vk !== undefined) {
      params.windowsVirtualKeyCode = vk;
      params.nativeVirtualKeyCode = vk;
    }
    // Without text, Enter won't submit Instagram's comment/search fields.
    if (m.kind !== "up" && m.key === "Enter") params.text = "\r";
    await this.cdp.send("Input.dispatchKeyEvent", params, this.sessionId).catch(() => {});
  }

  // ---- resize -------------------------------------------------------------

  // Trailing throttle: fire as soon as the rate limit allows. Mid-drag that
  // paces overrides at one per THROTTLE; when the drag stops, the pending
  // timer still fires and carries the final size. After an idle period the
  // deadline is already past, so the delay is 0 — fullscreen toggles and
  // panel snaps apply on the next tick rather than waiting out a debounce.
  private scheduleResize(): void {
    const now = Date.now();
    const delay = Math.max(0, this.lastResizeApplyAt + RESIZE_THROTTLE_MS - now);
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => void this.applyResize(), delay);
  }

  // Never runs concurrently with itself: an overlapping request could land an
  // older size after a newer one. Dims are read at dispatch time, so a queued
  // run always sends the freshest size rather than a stale snapshot.
  private async applyResize(): Promise<void> {
    this.resizeTimer = null;
    if (this.resizeInFlight) {
      this.resizeQueued = true;
      return;
    }
    if (!this.cdp || !this.sessionId || !this.view?.visible) return;
    const startedAt = Date.now();
    const { cssW, cssH } = this.dims;
    this.resizeInFlight = true;
    try {
      // Identical targets are deduped inside ChromeManager (no CDP traffic);
      // only a real override consumes the throttle budget.
      const applied = await this.chrome.setViewportSize(this.sessionId, cssW, cssH);
      if (applied) this.lastResizeApplyAt = startedAt;
    } catch {
      /* resize is best-effort */
    } finally {
      this.resizeInFlight = false;
      if (this.resizeQueued) {
        this.resizeQueued = false;
        this.scheduleResize();
      }
    }
  }

  // ---- commands / public API ----------------------------------------------

  async showBrowserWindow(): Promise<void> {
    if (!this.cdp || !this.sessionId) {
      await this.connect();
      if (!this.cdp || !this.sessionId) return;
    }
    await this.stopScreencast();
    await this.chrome.clearViewportOverride(this.sessionId);
    await this.chrome.showWindow(this.sessionId);
    this.postState("windowShown");
  }

  async hideBrowserWindow(): Promise<void> {
    // Cast must resume while the window is still onscreen/normal; starting
    // it after minimizing yields a dead stream.
    await this.startScreencast();
    await this.chrome.hideWindow();
    // Re-fit the page to the sidebar now that the window is parked again
    // (login cleared the viewport override).
    if (this.sessionId) {
      await this.chrome.setViewportSize(this.sessionId, this.dims.cssW, this.dims.cssH);
    }
    this.postState("live");
  }

  // Re-fit the page after a geometry setting changed (the target differs, so
  // ChromeManager's dedupe won't swallow it).
  refit(): void {
    this.scheduleResize();
  }

  // Encode quality is fixed when the cast starts, so re-cast to pick it up.
  async applyQuality(): Promise<void> {
    if (!this.casting || !this.view?.visible || this.chrome.isShown) return;
    if (this.chrome.parkedByMinimize) return; // restarting there would go dead
    await this.stopScreencast();
    await this.startScreencast();
  }

  async reloadPage(): Promise<void> {
    if (!this.cdp || !this.sessionId) return;
    await this.cdp.send("Page.reload", {}, this.sessionId).catch(() => {});
  }

  async restartChrome(): Promise<void> {
    await this.shutdown();
    await this.connect();
  }

  // Stop streaming and kill Chrome, but stay ready to reconnect later.
  async shutdown(): Promise<void> {
    await this.stopScreencast();
    for (const d of this.disposables) d();
    this.disposables = [];
    await this.chrome.dispose();
    this.cdp = null;
    this.sessionId = null;
    // ChromeManager marked itself disposed; build a fresh one for next time.
    this.chrome = this.makeChrome();
    this.postState("chromeDead");
  }

  async reveal(): Promise<void> {
    await vscode.commands.executeCommand("reelbar.view.focus");
  }

  private postState(state: string, detail?: string): void {
    this.view?.webview.postMessage({ type: "state", state, detail });
  }

  async dispose(): Promise<void> {
    for (const d of this.disposables) d();
    this.disposables = [];
    await this.chrome.dispose();
  }
}
