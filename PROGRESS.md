# Reelbar — Progress & Context

> Living document so any new chat/session has full context. Update this as work continues.
> Last updated: 2026-08-08.

## The goal (north star)

**Instagram must render INSIDE VS Code** — a sidebar view like the chat panel. The real Chrome
window is only the invisible engine behind it. It may appear onscreen for exactly one purpose:
first-time login / captcha / 2FA (Instagram only trusts real browser windows for auth), then it
parks again. It is never a user-facing surface otherwise.

## Architecture (v2, current)

No iframe (Instagram sends `X-Frame-Options: DENY` — browser-enforced, no bypass). No proxy
(breaks login, trips Meta bot detection). Instead, the Browse Lite pattern:

1. Spawn a **real headful Chrome** (`--remote-debugging-port=0`, persistent profile in
   `<globalStorage>/profile`). Never pass `--enable-automation` → `navigator.webdriver` stays
   `false` → Instagram sees a normal browser.
2. Attach over raw CDP WebSocket (tiny `ws`-based client, no puppeteer).
3. `Page.startScreencast` → JPEG frames → sidebar webview `<canvas>`.
4. Forward input from webview → `Input.dispatchMouseEvent` / `Input.insertText` / `dispatchKeyEvent`.
5. Park the Chrome window as a **near-offscreen sliver** (ask for huge offsets, macOS clamps to a
   ~40px chip at the bottom-left corner, hidden behind VS Code in practice; fully offscreen on
   other platforms). Audio keeps playing natively — reels have sound. Minimize is only a fallback.
6. Sidebar resizes → **viewport emulation** (`Emulation.setDeviceMetricsOverride`) while parked —
   sidebars are often taller than any real window can be, and emulation has no screen limit.
   Cleared when the window is shown for login (must look like a normal browser).
7. Login pages auto-detected by URL regex → sidebar overlay button "Open login window" →
   real window slides onscreen → user logs in → "I'm done — hide it" → parks again.

### Files

| File | Role |
|---|---|
| `src/cdp.ts` | Minimal CDP client over `ws` WebSocket (request/response + events, flat sessionId) |
| `src/chromeManager.ts` | Find/launch/attach Chrome, park/show window, resize viewport, kill |
| `src/reelView.ts` | `WebviewViewProvider` (`reelbar.view`): screencast loop, input dispatch, login detection, lifecycle |
| `src/windowMode.ts` | Legacy v1 external-window dock (fallback via `reelbar.mode: "window"`) |
| `src/extension.ts` | Activation, commands, status bar, mode routing |
| `media/main.js` | Webview: canvas latest-wins frame renderer + input capture + overlay states |
| `test/smoke-v2.js` | Smoke suite: stubs `vscode`, runs compiled `out/` against real Chrome |
| `PROGRESS.md` | This file |

Build: `npm run compile` (plain tsc → `out/`). Smoke: `npm run smoke` (or
`node test/smoke-v2.js T-D1 T-C` for named tests). Test in-editor: F5 (`Fn+F5` on Macs where
F5 = dictation) → Extension Development Host → Reelbar activity-bar icon or ⌘⇧9.

## Hard-won findings (do NOT re-learn these)

All verified empirically against real Chrome on this Mac. The smoke suite now lives IN THE REPO
at `test/smoke-v2.js` (stubs the `vscode` module, runs the compiled `out/` code, throwaway
profile) — no longer a scratchpad file that can be lost.

1. **Sliver park is the strategy that makes everything work** (2026-08-08, isolated-window
   matrix test): ask `Browser.setWindowBounds {left: -32000, top: 32000}` and let macOS clamp —
   it reliably leaves a ~40px chip at the bottom-left screen corner (`left=-460, top=915` for a
   500x900 window on this Mac; positive top pushes down — negative top clamps to the menu bar).
   The window stays `windowState: "normal"`, so: steady 10 frames/s screencast, live REAL window
   resizes while parked, audio, no fragile ordering. Windows/Linux: same code, fully offscreen.
2. **`Emulation.setFocusEmulationEnabled` is REQUIRED for frames while hidden** — a minimized
   window with focus emulation produces a steady 10/s; without it, exactly 0. (This explained a
   day of contradictory results. The extension always enables it in `setupSession()` — keep it.)
3. **`Emulation.setDeviceMetricsOverride` on a MINIMIZED window permanently stalls the screencast**
   (0 frames forever; even `Page.captureScreenshot` hangs; stop/restart cast doesn't help; only
   `Page.bringToFront` revives, which un-minimizes). On a NORMAL-state window the override is
   fine — frames keep flowing at the emulated size. Since sliver-parked windows stay "normal",
   the code now uses emulation for parked resizes (it can exceed screen height; a real-window
   resize can't — see the letterbox fix below). `setViewportSize` restores windowState "normal"
   before applying the override as a belt-and-suspenders guard.
4. **A screencast STARTED while minimized is dead** (0 frames). Minimize is now only the park
   fallback, but keep the ordering rule: start cast while the window is normal, then park.
5. **CDP `Input.dispatchMouseEvent` wheel deltas follow the DOM sign convention** (positive
   deltaY = scroll down). An earlier note claiming they're inverted was WRONG — proven by
   dispatching against a live page and reading `window.scrollY`. No negation in `dispatchMouse`.
6. **Instagram soft-blocks logins from fresh/chromeless profiles**: endless reCAPTCHA loop + FAKE
   "incorrect password" errors even with correct credentials. Password login from an untrusted
   context is the guarded door; real-window login / email reset link / FB OAuth are the side doors.
   v1's `--app` chromeless window was permanently stuck in this loop; a normal Chrome window works.
7. `.vscodeignore` must contain `!node_modules/ws/**` or the packaged VSIX crashes (no bundler).
8. Test-harness gotcha: register the `Page.screencastFrame` handler (which must ack every frame)
   BEFORE `Page.startScreencast` — an un-acked first frame stalls the stream and fakes a failure.
9. **A same-version VSIX reinstall does not reliably replace the cached extension** — bump the
   version and fully quit/reopen VS Code, or you will debug a stale build (cost a whole evening
   during the letterbox fix).
10. **Screencast frames are emitted only when the page actually repaints** (2026-08-08, v1.1.0
   smoke work). A synthetic test page needs a visibly animating element, or the stream looks
   dead when it is merely idle. Instagram animates constantly, so this only bites the harness.
11. **Mobile emulation on a page with no `<meta name="viewport">` falls back to the legacy 980px
   desktop viewport** — a 390-wide override then lays out at 980 (and scales). Instagram ships a
   viewport meta so production is fine; the smoke page must inject one or phone-mode assertions
   measure the wrong thing.
12. **A cast CAN be stopped and restarted while sliver-parked** (2026-08-08, T-D1 gate): 41 frames
   in 2s after a restart on a parked, normal-state window, including with a phone metrics override
   active. This is what makes stop-on-hide safe. Finding 4 (dead cast on a MINIMIZED window) did
   NOT reproduce under focus emulation on this Chrome — T-D6 recorded 51 frames — but the
   `parkedByMinimize` guard is kept anyway: on a machine where the sliver park fails, a dead
   stream is unrecoverable, and skipping the stop there costs nothing.

## Status log

- **v1 (0.1.0)**: external `--app` chromeless window docked beside editor. Worked mechanically;
  login permanently soft-blocked (finding 4). User rejected separate-window UX: "otherwise I could
  just resize Chrome". Kept as `windowMode.ts` fallback.
- **v2 (0.2.0) built 2026-08-08**: full architecture above. Compiles clean. CDP/screencast/park/
  resize mechanics smoke-tested outside VS Code. ✅
- **Login: DONE.** User logged into Instagram via the real Chrome window (trusted flow, no captcha
  loop). Session persists in `~/Library/Application Support/Code/User/globalStorage/opryon.reelbar/profile`.
  (Dev-host storage path; note the Extension Development Host may use a different globalStorage
  than an installed extension.)
- **Bug found & fixed & TEST-VERIFIED 2026-08-08**: closing the Chrome window by hand → extension
  recreates the tab (intended self-heal) in a NEW window, but `park()` used a stale cached
  `windowId` from the dead window → new window stayed visible → looked like an unkillable popup
  loop. Fix: invalidate `windowId` cache in `attachPage()`. Smoke-verified: new window gets parked.
- **2026-08-08, systematic smoke pass (8/8 green)**: standalone harness runs the compiled
  extension code against real Chrome. Found & fixed three real bugs before any user testing:
  (a) wheel scroll direction was inverted (finding 5); (b) resize-while-minimized froze the
  stream permanently (finding 3) — replaced minimize-park + emulation-resize with sliver-park +
  real window resizes (finding 1); (c) webview canvas stretched frames — now `object-fit:
  contain` with input mapped to the letterboxed content rect. All verified: park, steady frames
  while parked, live resize while parked, scroll direction, window-close resurrection, clean kill.

## Immediate next steps

1. **Verify the sidebar actually streams in VS Code** — the only unverified layer left is the
   extension-host/webview glue; every CDP mechanism underneath is smoke-tested green.
   F5 → open Reelbar activity-bar view → Instagram should stream. Expect: on first open the
   Chrome window flashes briefly, then parks as a ~40px chip at the bottom-left screen corner.
2. In the sidebar, verify: reels wheel-scroll (direction now correct by test), click, typing,
   ⌘V paste, audio while parked, drag-resize of the sidebar (page reflows ~200ms later).
3. Login state: profile already has a live Instagram session from earlier testing; if Instagram
   asks again, use the overlay "Open login window" → log in → "I'm done — hide it".
4. Startup flash: Chrome's window is briefly visible on first spawn before parking. Acceptable for
   now; could explore a faster park later.
5. Later: bundle with esbuild (drop the `.vscodeignore` negation hack), Windows/Linux park testing,
   marketplace publish prep (icon.png, repository field, `vsce package`).

## Milestone 2026-08-08 afternoon: USER-VERIFIED WORKING 🎉

Instagram streams and scrolls inside the VS Code sidebar (Extension Development Host). Repo
initialized and pushed to https://github.com/bugsmanager-hue/reelbar-vscode (private).

User feedback / backlog from first real session:
- **"Browser is still open"**: the parked Chrome is visible in Mission Control / other desktops
  (macOS always reveals real windows there — inherent to the real-browser architecture; the chip
  hides behind windows in normal use). Consider stealth polish later (smaller parked size).
  If the dev-host VS Code is fullscreen (its own Space), the chip lives on the desktop Space.
- **Right-side placement**: already supported by VS Code — drag the Reelbar icon into the
  secondary sidebar. Document prominently in README (tip already exists).
- **Autoscroll reels** (user idea): optional setting — auto-advance to the next reel when the
  current one ends (video `ended` detectable via CDP `Runtime.evaluate` listener). Good-to-have.
- Still to verify by user: typing/search, ⌘V paste, audio while parked, sidebar drag-resize.

## Letterbox fix (2026-08-08 evening) — FIXED, smoke-verified, awaiting user re-test

**Bug**: black letterbox bands above/below Instagram in the sidebar (installed 0.2.0, right
secondary sidebar). Root cause: sidebars are often TALLER (~1100px) than any real Chrome
window can be (screen caps it at ~900), so real-window resizing could never match and
`object-fit: contain` letterboxed the shortfall.

**Fix (shipped)**: parked resizes now use `Emulation.setDeviceMetricsOverride` (width/height =
sidebar CSS px, deviceScaleFactor 0, mobile false) — safe because sliver-parked windows stay
`windowState: "normal"` (the finding-3 stall is minimized-only). `setViewportSize` restores
"normal" first as a guard and is a no-op while the window is shown for login;
`clearViewportOverride` still runs on `showWindow`. The `chromeDelta` window-chrome
measurement in `instaView.applyResize` was deleted — emulation needs no chrome math.
Smoke T3 rewritten: emulated 470x1200 (taller than screen) while parked → 20 frames at
exactly 470x1200, `innerWidth/innerHeight` confirms real layout, window still a 40px sliver.
Wheel input verified under the override (T4). **Suite 8/8 green.** VSIX rebuilt + reinstalled.

**User re-test checklist**: sidebar fills full height (no black bands), reels scroll, click,
typing/search, ⌘V paste, audio while parked, sidebar drag-resize (reflow ~200ms).

**Gotcha found during re-test (now finding 9)**: bands persisted because the installed
extension host was STILL RUNNING THE OLD 0.2.0 BUILD — a same-version VSIX reinstall does not
reliably replace the cached extension. Proven by live read-only CDP inspection: window was
500x604 = cssH+87, the old real-resize fingerprint (and Chrome's ~500px minimum window width
explains why even narrow sidebars letterboxed). Bumped to 0.2.1 + full VS Code restart.
Also verified via JPEG SOF probe: under 470x1200 emulation the actual frame bitmap is a true
940x2400 — no baked-in bars; and macOS clamps real window height at 923 (asked 1400).

**Same evening — shutdown discoverability fixed**: `reelbar.close` (kills the hidden Chrome
completely) already existed but was buried in the palette. Added `view/title` menu buttons:
⏹ stop (`reelbar.close`) + ↻ reload in the title bar, show/hide-window and restart in the
view's `···` overflow. After shutdown the webview shows "The browser closed." with a Reopen
button. Idle-timeout auto-kill stays on the backlog.

## 0.2.2 (2026-08-08): letterbox CONFIRMED FIXED by user + opt-in mobile UI

After the 0.2.1 restart the sidebar fills edge to edge (user screenshots: home feed + explore
grid perfect). Remaining complaint: Instagram's WEB reels layout wastes a tall sidebar (small
9:16 card + black page background). Added `reelbar.mobileUI` (default OFF): iPhone UA via
`Emulation.setUserAgentOverride` (set once per session in setupSession — never flip-flop
mid-session) + `mobile: true` in the metrics override → Instagram serves its phone UI with
full-bleed reels. Takes effect after Reload Page / Restart Browser. Turn off if Instagram
gets suspicious (UA change on an existing session may prompt a re-login). Suite 8/8 on the
default path; mobile path is user-tested. VSIX 0.2.2 installed.

## 0.2.3 (2026-08-08): virtual phone (mobileUI reworked)

User showed Instagram's WEB layouts break at odd emulated widths (fixed-px buttons don't
shrink, caption/username columns collapse to one char per line — "not responsive"). Rework of
`reelbar.mobileUI` into a **virtual phone**: pin emulated width to 390 (standard phone,
Instagram's mobile CSS is designed for it), derive height from the sidebar's aspect ratio
(a fixed phone height would reintroduce letterboxing), deviceScaleFactor 2 for sharpness,
`mobile: true`, iPhone UA + `userAgentMetadata` (without metadata the Sec-CH-UA client-hints
headers would still say "Chromium on macOS" and contradict the UA string; fallback to plain
UA if Chrome rejects the metadata shape). Canvas scale-to-fit + input mapping need no changes
(aspect matches by construction). Smoke suite now 9/9 (new T3m: 470x1200 sidebar → 390x996).
Known risk to verify by user: mobile-web reels may prefer touch gestures over wheel for snap
scroll — if scrolling feels dead in mobile mode, next step is synthesizing touch events.
NOT the invisibility fix — the parked real window is unchanged (backlog: offscreen rendering).

## 🏆 v1.0.0 (2026-08-08 evening): USER DECLARED IT DONE

Virtual phone mode confirmed working by user screenshot — Instagram phone UI rendering
correctly in the sidebar (proper reel layout, scaled buttons, clean username/caption).
User: "its done bro … lets call it final version 1". Tagged v1.0.0, GitHub release with
VSIX attached. Remaining backlog (post-1.0): touch-event synthesis if wheel scroll ever
misbehaves in mobile mode, zen-mode CSS injection, autoscroll-reels setting, full engine
invisibility research (Electron/CEF offscreen), startup flash, esbuild bundling,
marketplace publish (icon.png needed), Windows/Linux park testing.

## 1.1.0 (2026-08-08): responsiveness overhaul — 17/17 smoke green

Audit of the shipped 1.0.1 (installed build verified identical to the repo build; `ws` at latest)
found the mechanics correct but the *feel* laggy. Plan was adversarially cross-checked before any
code was written, which caught three bugs the audit had missed. All of it is now implemented.

**Resize — the headline fix.** The old pipeline was a flat 200ms trailing debounce plus a
"micro-jitter skip" that compared sidebar CSS px against `lastFrameMeta`. In phone mode the frames
are always ~390x844 while the sidebar is ~470x1100, so the skip **never fired** and every single
resize tick re-sent a full `setDeviceMetricsOverride` — each one a full Instagram reflow. Now:

- Dedupe moved into `ChromeManager` and keyed on the **computed emulated target**
  (`lastAppliedViewport`), so identical targets cost zero CDP traffic. Verified: a width-only drag
  at the phone height cap sends **0** overrides (T-C1).
- `instaView` runs a **trailing throttle** (250ms), not a debounce. Every apply reads `this.dims`
  at dispatch time, so the last tick of a drag always carries the final size — no settle delay
  needed. After an idle period the deadline has already passed, so fullscreen toggles and panel
  snaps apply on the next tick. A synthetic 20-message drag collapses to 9 overrides and lands the
  exact final size (T-C2). Applies are serialized, so an older size can never land after a newer.
- **Hidden views no longer reshape the page.** A hidden webview reports a collapsed body; the old
  code would happily apply a 1x1-derived viewport to the live page and reflow it back on show.
  Resize messages are now gated on `view.visible` plus a 50px sanity floor (T-C3).

**Cast lifecycle (battery).** The stream now stops when the view is hidden and restarts on show,
after re-fitting so the first frame back is already the right size (T-D5). The old "restarting is
unsafe" comment dated from the minimize-park era; finding 12 above is the gate that cleared it.
Guarded by `parkedByMinimize` so machines where the sliver park fails keep today's behavior (T-D4).
Audio is untouched — podcast mode still works while hidden.

**Input/render hot paths.** Wheel events were one CDP round-trip each (60–120/s on a trackpad,
competing with frame acks on the same socket); they now accumulate and flush on a 16ms timer —
a *timer*, not rAF, which is throttled when the webview is occluded and would strand a gesture.
A pending scroll is flushed synchronously before any click/key/paste so "scroll then click" can
never reorder. Frames ship as raw `Uint8Array` JPEG instead of base64 (a third less payload,
no data-URL string churn) and decode via `createImageBitmap` off the main thread, with the old
`<img>` path kept as a fallback. CSP gained `blob:` for that fallback.

**Bugs fixed.** (a) The view force-unmuted **all** media on every show, clobbering a mute the user
had set in Instagram's own UI — now tracked with `mutedByUs`. (b) `Cdp.send`/`connect` could pend
forever; both now time out at 15s, which also unbricks the `connecting` flag that made the Retry
button a no-op after a hang. (c) `mobileUI` was half-live — `setViewportSize` read it fresh on
every resize while the UA was set once per session, so a mid-session toggle paired phone metrics
with a desktop UA (exactly the breakage 0.2.3 existed to fix). It is now pinned per session via
`setSessionMobile()`. (d) `quality`/`url`/`mobileUI` changes were silently ignored; quality now
re-casts live, the other two prompt to restart the browser.

**Deliberately NOT done** (cross-check verdicts): no cover/crop during the resize lag — cropping
desyncs visible pixels from where clicks land, and `norm()`'s letterbox mapping is already
correct; no rAF wheel flushing; no binary-postMessage feature handshake (a `typeof` branch in the
webview is the whole fallback).

**User verification checklist**: sidebar drag + window resize + fullscreen toggle track within
~300ms; reels snap one-per-gesture in BOTH desktop and phone mode; scroll-then-click hits the
right reel; clicks land correctly right after a resize; mute a reel in Instagram's UI then hide/
show the view (stays muted); hide the sidebar → Chrome CPU drops, audio continues → reshow gives
a live frame in ~300ms; toggle `mobileUI` → restart prompt.

## 1.2.0 (2026-08-08): phone UI by default, arrow-key reel stepping, space to pause

Measured the live page instead of guessing — three findings, each of which
contradicted a plausible assumption:

1. **`mobileUI` had never been on.** The live UA was not an iPhone and the
   viewport was 563x799, not the 390 the virtual phone pins. Every "two reels"
   report was the DESKTOP layout, so the 844 height cap was never even running.
   It is now **default true** — the phone layout is the product.
2. **The desktop layout cannot be fixed by sizing.** Measured law (fits 12
   sweep samples within 2px): `cardW = min(vw - 138, (vh - 84) * 9/16)`,
   `cardH = cardW * 16/9`, `pitch = cardH + 34`, `reels = (vh - 50) / pitch`.
   The 138px action column is FIXED, so one reel needs `vw >= 138 + 0.5625*(vh - 84)`
   — about 540px at an 800px-tall sidebar. Narrowing the sidebar shrinks the
   card and therefore fits MORE reels, which is why it got worse, not better.
   The phone layout has no such column: card is a full-bleed 390x844, pitch 799.
3. **Instagram binds nothing to the arrow keys.** A press fell through to the
   browser's default ~40px scroll — about 20 presses per reel. And it does NOT
   pause on tap: a real `Input.dispatchTouchEvent` tap changed nothing.

So arrows and space are handled extension-side now. Arrows scroll the feed by
one measured pitch (never a hardcoded number — it is 799 on phone, 749 on
desktop) anchored to the nearest reel edge, so a nudged feed re-aligns instead
of drifting. A pending-target stamp makes fast repeated presses advance one
reel each rather than re-completing the in-flight smooth scroll. Space toggles
the most-centred video directly. Both defer with `"typing"` when the focus is
in an input/textarea/contenteditable, so comments still type normally.

**Do NOT use `Emulation.setEmitTouchEventsForMouse`** — with it enabled,
`Input.dispatchMouseEvent` never returns (hit the new 15s CDP timeout, which is
how it was caught). Touch is not needed anyway, per finding 3.

## 2.1.0 (2026-08-16): multi-panel — Instagram, YouTube Music, Slack (PR #1)

First outside contribution (PR #1, @ishansinghal1234): three sidebar panels,
each with its own hidden Chrome, profile, and CDP session. YT Music and Slack
are desktop-first (mobileUI is Instagram-only); arrows/space pass through to
their native players instead of running reel-step JS. Slack ships a three-layer
defence so workspace navigation stays in the panel: `slack://` excluded via
Chrome prefs written before first launch, window.open/anchor interception
injected on every document, and a CDP target watcher that pulls orphan
app.slack.com/client tabs back into the main one.

Review fixes applied on top of the contribution (all verified live):

1. **Kept the view container on `activitybar`.** The PR moved it to
   `secondarySideBar`, which needs VS Code ≥1.97 while we declare ^1.80 —
   invalid contribution, view falls back to Explorer on older builds.
2. **Space in a text field types a space again.** The non-Instagram space
   path always dispatched a bare keyDown (no text), so YT Music search and
   Slack messages could never contain spaces ("hey jude" → "heyjude").
   Now guarded by IS_TYPING_JS, falling through to insertText while typing.
3. **Instagram keeps the legacy `profile` subdir.** The rewrite moved it to
   `profile-instagram`, which would log every existing user out on upgrade.
4. **ChromeManager's startUrl falls back to the `reelbar.url` setting** when
   not passed (the rewrite hardcoded instagram.com, which sent every direct-
   launch smoke test to the real site — nondeterministic frames/layout).
5. **YT Music + Slack views default collapsed** so opening the sidebar spawns
   one Chrome, not three; each panel's Chrome launches on first expand.
6. **Restart Browser only restarts open/running panels**, not all three.

Unauthenticated Slack redirects to the marketing page (slack.com/intl/…), not
signin — loginNeeded fires when the user proceeds to sign in, with
service-specific overlay copy (the webview `detail` plumbing already existed).

Verified: smoke 22/22 (Instagram path unregressed) + a new 18/18 live harness
(scratchpad) covering YT Music, Slack (prefs, injection, login detection,
typing), and two panels streaming simultaneously from one storage root.

## Development context

- Primary target: macOS on Apple Silicon with Chrome installed. Window parking is macOS-tuned;
  Linux/Windows take the "fully offscreen" path and are untested.
- Design goal: no login rituals for end users beyond the one-time real-window auth. Everything
  else should just work at any sidebar size.
- All findings above were verified against a real, logged-in Instagram session. Reproducing them
  needs an account logged in through the extension's own browser profile.
