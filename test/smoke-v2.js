#!/usr/bin/env node
// Reelbar smoke suite (v2.1) — runs the COMPILED out/ code against a real
// Chrome with a throwaway profile, with the `vscode` module stubbed.
//
//   node smoke-v2.js            # all tests
//   node smoke-v2.js T-D1 T-C   # only named tests
//
// Never touches the user's real Reelbar profile or Instagram session.

const Module = require("module");
const path = require("path");
const fs = require("fs");
const os = require("os");

const REPO = path.resolve(__dirname, "..");
const OUT = path.join(REPO, "out");

// ---- vscode stub ---------------------------------------------------------

const settings = {
  url: "about:blank",
  quality: 70,
  mobileUI: false,
  muteWhenHidden: false,
  browserPath: "",
  mode: "sidebar",
};

const vscodeStub = {
  workspace: {
    getConfiguration: () => ({
      get: (key, def) => (settings[key] !== undefined ? settings[key] : def),
    }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  window: {
    showErrorMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    createStatusBarItem: () => ({ show() {}, dispose() {} }),
    registerWebviewViewProvider: () => ({ dispose() {} }),
  },
  commands: { executeCommand: async () => undefined, registerCommand: () => ({ dispose() {} }) },
  StatusBarAlignment: { Right: 2 },
  Uri: {
    joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) }),
    file: (p) => ({ fsPath: p }),
  },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return vscodeStub;
  return origLoad.call(this, request, parent, isMain);
};

const { ChromeManager } = require(path.join(OUT, "chromeManager.js"));
const { ReelViewProvider } = require(path.join(OUT, "reelView.js"));
const { Cdp } = require(path.join(OUT, "cdp.js"));
const { reelStepJs, TOGGLE_PLAY_JS } = require(path.join(OUT, "reelView.js"));

// ---- harness -------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeContext() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reelbar-smoke-"));
  return {
    dir,
    context: {
      globalStorageUri: { fsPath: dir },
      extensionUri: { fsPath: REPO },
      subscriptions: [],
    },
  };
}

// Minimal stand-in for a WebviewView so the real provider code runs unchanged.
function makeFakeView(visible = true) {
  const msgHandlers = [];
  const visHandlers = [];
  const posted = [];
  const view = {
    get visible() {
      return this._visible;
    },
    _visible: visible,
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-resource:",
      asWebviewUri: (u) => "vscode-resource://" + u.fsPath,
      onDidReceiveMessage: (h) => (msgHandlers.push(h), { dispose() {} }),
      postMessage: (m) => (posted.push(m), Promise.resolve(true)),
    },
    onDidChangeVisibility: (h) => (visHandlers.push(h), { dispose() {} }),
    onDidDispose: () => ({ dispose() {} }),
  };
  return {
    view,
    posted,
    send: (m) => msgHandlers.forEach((h) => h(m)),
    setVisible(v) {
      view._visible = v;
      visHandlers.forEach((h) => h());
    },
    frames: () => posted.filter((m) => m.type === "frame"),
    states: () => posted.filter((m) => m.type === "state").map((m) => m.state),
  };
}

// Count frames arriving on a raw CDP session (ack every one — an un-acked
// first frame stalls the stream and fakes a failure).
function countFrames(cdp, sessionId) {
  const state = { n: 0, last: null };
  const off = cdp.on("Page.screencastFrame", (params, sid) => {
    if (sid !== sessionId) return;
    state.n++;
    state.last = params.metadata || {};
    cdp.send("Page.screencastFrameAck", { sessionId: params.sessionId }, sessionId).catch(() => {});
  });
  state.stop = off;
  return state;
}

async function startCast(cdp, sessionId, quality = 70) {
  await cdp.send(
    "Page.startScreencast",
    { format: "jpeg", quality, maxWidth: 2048, maxHeight: 2560, everyNthFrame: 1 },
    sessionId
  );
}

// A tall, scrollable page with a click target — no network, deterministic.
async function setupTestPage(cdp, sessionId) {
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send(
    "Runtime.evaluate",
    {
      expression: `
        document.title = "smoke";
        // Without a viewport meta, mobile emulation falls back to the legacy
        // 980px desktop viewport — Instagram ships one, so the test page must
        // too, or phone-mode assertions measure the wrong thing.
        (function () {
          var m = document.createElement("meta");
          m.name = "viewport";
          m.content = "width=device-width, initial-scale=1";
          document.head.appendChild(m);
        })();
        document.body.style.margin = "0";
        document.body.innerHTML =
          '<div id="hit" style="height:200px;background:#0a0"></div>' +
          '<div id="anim" style="height:120px;background:#000"></div>' +
          '<div style="height:20000px;background:linear-gradient(#f00,#00f)"></div>';
        window.__clicks = 0;
        document.getElementById("hit").addEventListener("click", () => window.__clicks++);
        // Chrome only emits a screencast frame when something actually
        // repaints; keep a visible element changing so the stream has content.
        (function () {
          var box = document.getElementById("anim");
          var i = 0;
          setInterval(function () {
            box.style.background = "hsl(" + (i = (i + 17) % 360) + ",80%,50%)";
          }, 50);
        })();
        "ok"`,
      returnByValue: true,
    },
    sessionId
  );
}


// A reels-like page: a scroll container of fixed-height "reels", each with a
// fake <video> whose play/pause state is observable (a real <video> with no
// source can't actually play, which would make the toggle test meaningless).
async function setupReelsPage(cdp, sessionId, { pitch = 800, count = 10 } = {}) {
  await cdp.send("Runtime.enable", {}, sessionId).catch(() => {});
  await cdp.send(
    "Runtime.evaluate",
    {
      expression: `
        document.body.style.margin = "0";
        document.body.innerHTML =
          '<div id="feed" style="height:100vh;overflow-y:scroll"></div>' +
          '<input id="typebox">';
        const feed = document.getElementById("feed");
        window.__log = [];
        for (let i = 0; i < ${count}; i++) {
          const card = document.createElement("div");
          card.style.cssText = "height:${pitch}px;position:relative";
          const v = document.createElement("video");
          v.style.cssText = "display:block;width:100%;height:100%";
          v.dataset.i = i;
          let paused = true;
          Object.defineProperty(v, "paused", { get: () => paused });
          v.play = () => { paused = false; window.__log.push("play:" + i); };
          v.pause = () => { paused = true; window.__log.push("pause:" + i); };
          card.appendChild(v);
          feed.appendChild(card);
        }
        "ok"`,
      returnByValue: true,
    },
    sessionId
  );
}

const feedTop = (cdp, sessionId) =>
  evalPage(cdp, sessionId, "Math.round(document.getElementById('feed').scrollTop)");

// Smooth scrolling is animated; poll until it stops moving rather than guessing
// a sleep (a fixed wait flakes when the machine is busy running the suite).
async function settledFeedTop(cdp, sessionId, timeoutMs = 6000) {
  let last = null, stable = 0;
  for (let waited = 0; waited < timeoutMs; waited += 100) {
    await sleep(100);
    const v = await feedTop(cdp, sessionId);
    stable = v === last ? stable + 1 : 0;
    last = v;
    // A busy machine can stall the animation long enough to look settled, so
    // require both a minimum elapsed time and several identical reads.
    if (stable >= 4 && waited >= 900) break;
  }
  return last;
}

const setFeedTop = (cdp, sessionId, v) =>
  evalPage(cdp, sessionId, `document.getElementById('feed').scrollTop=${v}; 1`);

const evalPage = async (cdp, sessionId, expression) =>
  (
    await cdp.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId)
  ).result.value;

async function windowBounds(cdp, targetId) {
  const { windowId } = await cdp.send("Browser.getWindowForTarget", { targetId });
  const { bounds } = await cdp.send("Browser.getWindowBounds", { windowId });
  return { windowId, bounds };
}

const isParked = (b) => b.windowState === "minimized" || b.left + b.width <= 64;

// ---- tests ---------------------------------------------------------------

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---- T1/T2: park + frames while parked ----------------------------------
test("T1+T2 park keeps a live screencast (sliver, windowState normal)", async (t) => {
  const { cdp, sessionId, chrome } = await t.launch();
  await setupTestPage(cdp, sessionId);
  const frames = countFrames(cdp, sessionId);
  await startCast(cdp, sessionId);
  await chrome.park();
  await sleep(2000);
  const { bounds } = await windowBounds(cdp, chrome.pageTargetId);
  t.assert(isParked(bounds), `window parked (got left=${bounds.left} w=${bounds.width})`);
  t.assert(bounds.windowState === "normal", `stays windowState normal (got ${bounds.windowState})`);
  t.assert(frames.n >= 10, `>=10 frames while parked (got ${frames.n})`);
  t.assert(!chrome.parkedByMinimize, "parkedByMinimize false on the sliver path");
});

// ---- T3: emulated resize taller than the screen --------------------------
test("T3 emulated resize while parked exceeds screen height", async (t) => {
  const { cdp, sessionId, chrome } = await t.launch();
  await setupTestPage(cdp, sessionId);
  const frames = countFrames(cdp, sessionId);
  await startCast(cdp, sessionId);
  await chrome.park();
  const applied = await chrome.setViewportSize(sessionId, 470, 1200);
  t.assert(applied === true, "setViewportSize reports an override was sent");
  await sleep(1500);
  t.assert(frames.n >= 5, `frames keep flowing after override (got ${frames.n})`);
  t.assert(
    frames.last.deviceWidth === 470 && frames.last.deviceHeight === 1200,
    `frame meta is 470x1200 (got ${frames.last.deviceWidth}x${frames.last.deviceHeight})`
  );
  const inner = await evalPage(cdp, sessionId, "innerWidth + 'x' + innerHeight");
  t.assert(inner === "470x1200", `page really lays out at 470x1200 (got ${inner})`);
  const { bounds } = await windowBounds(cdp, chrome.pageTargetId);
  t.assert(isParked(bounds), "window is still parked after the override");
});

// ---- T3m: virtual phone target ------------------------------------------
test("T3m virtual phone pins 390 wide and caps height at 844", async (t) => {
  const { cdp, sessionId, chrome } = await t.launch();
  await setupTestPage(cdp, sessionId);
  const frames = countFrames(cdp, sessionId);
  await startCast(cdp, sessionId);
  await chrome.park();
  chrome.setSessionMobile(true); // pinned per session, as instaView does
  await chrome.setViewportSize(sessionId, 470, 1200);
  await sleep(1200);
  const inner = await evalPage(cdp, sessionId, "innerWidth + 'x' + innerHeight");
  t.assert(inner === "390x844", `capped phone viewport (got ${inner})`);
  t.assert(frames.n >= 5, `frames flow in phone mode (got ${frames.n})`);
});

// ---- T-C1: viewport dedupe (the mobile-drag bug) -------------------------
test("T-C1 identical targets send zero CDP overrides", async (t) => {
  const { cdp, sessionId, chrome } = await t.launch();
  await setupTestPage(cdp, sessionId);
  await chrome.park();
  chrome.setSessionMobile(true);

  const overrides = t.countOverrides(cdp);
  await chrome.setViewportSize(sessionId, 470, 1200); // → 390x844 (at cap)
  const afterFirst = overrides.n;
  // Width-only drag while pinned at the height cap: same 390x844 target.
  // (The cap holds while 390*1200/w >= 844, i.e. w <= 554.)
  for (const w of [480, 500, 520, 540, 550]) {
    await chrome.setViewportSize(sessionId, w, 1200);
  }
  t.assert(afterFirst === 1, `first apply sends exactly one override (got ${afterFirst})`);
  t.assert(
    overrides.n === 1,
    `5 same-target resizes send NO further overrides (got ${overrides.n - 1} extra)`
  );

  // A genuinely different target must still get through.
  await chrome.setViewportSize(sessionId, 470, 600);
  t.assert(overrides.n === 2, `a real change still applies (got ${overrides.n})`);
});

// ---- T-C2: the resize pump under a synthetic drag ------------------------
test("T-C2 resize pump throttles a drag and lands the exact final size", async (t) => {
  const { provider, fake, cdp, sessionId } = await t.launchProvider();
  await setupTestPage(cdp, sessionId);
  const overrides = t.countOverrides(cdp);

  // 20 resize messages over ~2s, as a slow sidebar drag would produce.
  for (let i = 0; i < 20; i++) {
    fake.send({ type: "resize", cssW: 400 + i * 5, cssH: 900 + i * 5, dpr: 2 });
    await sleep(100);
  }
  await sleep(700); // settle

  t.assert(
    overrides.n >= 2 && overrides.n <= 12,
    `drag coalesced to a handful of overrides (got ${overrides.n} for 20 messages)`
  );
  const inner = await evalPage(cdp, sessionId, "innerWidth + 'x' + innerHeight");
  t.assert(inner === "495x995", `final size is exact, not stale (got ${inner})`);
});

// ---- T-C3: hidden view must not reshape the page -------------------------
test("T-C3 hidden view ignores collapsed resize reports", async (t) => {
  const { provider, fake, cdp, sessionId } = await t.launchProvider();
  await setupTestPage(cdp, sessionId);
  fake.send({ type: "resize", cssW: 470, cssH: 1000, dpr: 2 });
  await sleep(600);
  const before = await evalPage(cdp, sessionId, "innerWidth + 'x' + innerHeight");

  fake.setVisible(false);
  fake.send({ type: "resize", cssW: 1, cssH: 1, dpr: 2 }); // what a collapsed view reports
  await sleep(600);
  const after = await evalPage(cdp, sessionId, "innerWidth + 'x' + innerHeight");

  t.assert(before === "470x1000", `sane size applied while visible (got ${before})`);
  t.assert(after === before, `1x1 report ignored while hidden (got ${after})`);
});

// ---- T4 + T-A: wheel direction and coalescing equivalence ----------------
test("T4+T-A wheel scrolls down, and one summed event == many small ones", async (t) => {
  const { cdp, sessionId, chrome } = await t.launch();
  await setupTestPage(cdp, sessionId);
  await chrome.park();
  await chrome.setViewportSize(sessionId, 470, 900);
  await sleep(400);

  const wheel = (dy) =>
    cdp.send(
      "Input.dispatchMouseEvent",
      { type: "mouseWheel", x: 200, y: 400, deltaX: 0, deltaY: dy },
      sessionId
    );

  await evalPage(cdp, sessionId, "scrollTo(0,0); 1");
  for (let i = 0; i < 10; i++) await wheel(30);
  await sleep(600);
  const many = await evalPage(cdp, sessionId, "Math.round(scrollY)");

  await evalPage(cdp, sessionId, "scrollTo(0,0); 1");
  await wheel(300); // the coalesced equivalent
  await sleep(600);
  const summed = await evalPage(cdp, sessionId, "Math.round(scrollY)");

  t.assert(many > 0, `positive deltaY scrolls DOWN (scrollY=${many}, no negation)`);
  t.assert(
    Math.abs(many - summed) <= 2,
    `coalesced delta scrolls the same distance (many=${many} summed=${summed})`
  );
});

// ---- T-D1: THE PHASE-3 GATE ---------------------------------------------
test("T-D1 [GATE] a screencast can be stopped and restarted while sliver-parked", async (t) => {
  const { cdp, sessionId, chrome } = await t.launch();
  await setupTestPage(cdp, sessionId);
  const frames = countFrames(cdp, sessionId);
  await startCast(cdp, sessionId);
  await chrome.park();
  await sleep(1500);
  const running = frames.n;
  t.assert(running >= 5, `baseline cast is alive (got ${running})`);

  await cdp.send("Page.stopScreencast", {}, sessionId);
  await sleep(300);
  const atStop = frames.n;
  await sleep(1500);
  t.assert(frames.n - atStop === 0, `stop really stops (got ${frames.n - atStop} stray frames)`);

  const { bounds } = await windowBounds(cdp, chrome.pageTargetId);
  t.assert(isParked(bounds) && bounds.windowState === "normal", "still sliver-parked at restart");

  const beforeRestart = frames.n;
  await startCast(cdp, sessionId); // <-- the unverified condition
  await sleep(2000);
  const after = frames.n - beforeRestart;
  t.assert(after >= 10, `restart while parked yields frames (got ${after} in 2s)`);
});

// ---- T-D2: restart under a phone override -------------------------------
test("T-D2 stop/restart survives an active phone metrics override", async (t) => {
  const { cdp, sessionId, chrome } = await t.launch();
  await setupTestPage(cdp, sessionId);
  const frames = countFrames(cdp, sessionId);
  await startCast(cdp, sessionId);
  await chrome.park();
  chrome.setSessionMobile(true);
  await chrome.setViewportSize(sessionId, 470, 1200); // 390x844 @ dsf 2
  await sleep(1000);

  await cdp.send("Page.stopScreencast", {}, sessionId);
  await sleep(500);
  const before = frames.n;
  await startCast(cdp, sessionId);
  await sleep(2000);
  t.assert(frames.n - before >= 10, `frames resume (got ${frames.n - before})`);
  t.assert(
    frames.last.deviceWidth === 390 && frames.last.deviceHeight === 844,
    `override survives the restart (got ${frames.last.deviceWidth}x${frames.last.deviceHeight})`
  );
});

// ---- T-D3: quality restart ----------------------------------------------
test("T-D3 restarting with a new quality keeps frames flowing", async (t) => {
  const { cdp, sessionId, chrome } = await t.launch();
  await setupTestPage(cdp, sessionId);
  const frames = countFrames(cdp, sessionId);
  await startCast(cdp, sessionId, 40);
  await chrome.park();
  await sleep(1200);
  await cdp.send("Page.stopScreencast", {}, sessionId);
  await sleep(400);
  const before = frames.n;
  await startCast(cdp, sessionId, 95);
  await sleep(1800);
  t.assert(frames.n - before >= 8, `frames flow at the new quality (got ${frames.n - before})`);
});

// ---- T-D4: the minimize guard actually suppresses the stop ---------------
// PROGRESS finding 4 says a cast started while minimized is dead. Whether it
// still reproduces on this Chrome is recorded below for the record, but the
// guard is kept regardless — on a machine where the sliver park fails, a dead
// stream is unrecoverable, so the conservative branch costs nothing.
test("T-D4 minimize-parked sessions never stop the cast on hide", async (t) => {
  const { provider, fake, cdp, sessionId, chrome } = await t.launchProvider();
  await setupTestPage(cdp, sessionId);
  await sleep(1200);

  const before = fake.frames().length;
  await sleep(1200);
  t.assert(fake.frames().length > before, "cast is live while the view is visible");

  // Pretend the sliver park failed on this machine.
  chrome.minimizedPark = true;
  fake.setVisible(false);
  await sleep(1500);
  const atHide = fake.frames().length;
  await sleep(1500);
  t.assert(
    fake.frames().length > atHide,
    `frames keep flowing when minimize-parked (guard held; got ${fake.frames().length - atHide})`
  );

  // And the normal (sliver) path DOES stop.
  chrome.minimizedPark = false;
  fake.setVisible(true);
  await sleep(800);
  fake.setVisible(false);
  await sleep(1200);
  const afterStop = fake.frames().length;
  await sleep(1500);
  t.assert(
    fake.frames().length === afterStop,
    `sliver-parked hide stops the cast (got ${fake.frames().length - afterStop} stray frames)`
  );
});

// ---- T-D5: hide/show round-trip restores a correctly sized stream --------
test("T-D5 re-showing the view resumes frames at the current size", async (t) => {
  const { provider, fake, cdp, sessionId } = await t.launchProvider();
  await setupTestPage(cdp, sessionId);
  fake.send({ type: "resize", cssW: 470, cssH: 1000, dpr: 2 });
  await sleep(800);

  fake.setVisible(false);
  await sleep(1200);
  const parked = fake.frames().length;
  await sleep(1200);
  t.assert(fake.frames().length === parked, "no frames encoded while hidden");

  fake.setVisible(true);
  await sleep(2000);
  const resumed = fake.frames().length - parked;
  t.assert(resumed >= 10, `frames resume promptly on show (got ${resumed} in 2s)`);
  const inner = await evalPage(cdp, sessionId, "innerWidth + 'x' + innerHeight");
  t.assert(inner === "470x1000", `resumed at the right size (got ${inner})`);
});

// ---- T-D6 (informational): does finding 4 still reproduce? ---------------
test("T-D6 [record] cast restarted while MINIMIZED", async (t) => {
  const { cdp, sessionId, chrome } = await t.launch();
  await setupTestPage(cdp, sessionId);
  const frames = countFrames(cdp, sessionId);
  await startCast(cdp, sessionId);
  await chrome.park();
  await sleep(1000);

  const { windowId } = await windowBounds(cdp, chrome.pageTargetId);
  await cdp.send("Page.stopScreencast", {}, sessionId);
  await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } });
  await sleep(500);
  const before = frames.n;
  await startCast(cdp, sessionId);
  await sleep(2500);
  const got = frames.n - before;
  console.log(
    `    · minimized restart produced ${got} frames in 2.5s ` +
      `(finding 4 predicted ~0; focus emulation is enabled here)`
  );
  await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
  t.assert(true, "recorded (informational — the guard is kept either way)");
});

// ---- T-B: frames reach the webview as raw JPEG bytes ---------------------
test("T-B frames are posted as Uint8Array JPEG (not base64 strings)", async (t) => {
  const { fake, cdp, sessionId } = await t.launchProvider();
  await setupTestPage(cdp, sessionId);
  await sleep(1500);
  const frames = fake.frames();
  t.assert(frames.length > 0, `frames were posted (got ${frames.length})`);
  const d = frames[frames.length - 1].data;
  t.assert(d instanceof Uint8Array, `payload is a Uint8Array (got ${d && d.constructor.name})`);
  t.assert(
    d[0] === 0xff && d[1] === 0xd8 && d[d.length - 2] === 0xff && d[d.length - 1] === 0xd9,
    `payload is a complete JPEG (SOI..EOI, ${d.length} bytes)`
  );
});


// ---- T-K: arrow-key reel stepping + space to pause ----------------------
test("T-K1 ArrowDown/Up move exactly one reel and stay aligned", async (t) => {
  const { cdp, sessionId, chrome } = await t.launch();
  await setupReelsPage(cdp, sessionId);
  await chrome.park();
  await chrome.setViewportSize(sessionId, 390, 800);
  await sleep(500);

  t.assert((await feedTop(cdp, sessionId)) === 0, "starts at the top");
  t.assert((await evalPage(cdp, sessionId, reelStepJs(1))) === "snap", "ArrowDown reports a snap");
  const one = await settledFeedTop(cdp, sessionId);
  t.assert(one === 800, `one press = exactly one reel (got ${one})`);

  await evalPage(cdp, sessionId, reelStepJs(1));
  const two = await settledFeedTop(cdp, sessionId);
  t.assert(two === 1600, `two presses = two reels (got ${two})`);

  await evalPage(cdp, sessionId, reelStepJs(-1));
  const back = await settledFeedTop(cdp, sessionId);
  t.assert(back === 800, `ArrowUp goes back one reel (got ${back})`);
});

test("T-K2 a misaligned feed re-aligns instead of drifting", async (t) => {
  const { cdp, sessionId, chrome } = await t.launch();
  await setupReelsPage(cdp, sessionId);
  await chrome.park();
  await chrome.setViewportSize(sessionId, 390, 800);
  await sleep(500);

  await setFeedTop(cdp, sessionId, 830); // 30px past a boundary
  await evalPage(cdp, sessionId, reelStepJs(1));
  const got = await settledFeedTop(cdp, sessionId);
  t.assert(got === 1600, `lands on a clean boundary, not 830+800=1630 (got ${got})`);
});

test("T-K2b three quick presses advance three reels", async (t) => {
  const { cdp, sessionId, chrome } = await t.launch();
  await setupReelsPage(cdp, sessionId);
  await chrome.park();
  await chrome.setViewportSize(sessionId, 390, 800);
  await sleep(500);

  // No waiting between presses — each must build on the pending target, not on
  // the half-finished scroll position.
  for (let i = 0; i < 3; i++) await evalPage(cdp, sessionId, reelStepJs(1));
  const got = await settledFeedTop(cdp, sessionId);
  t.assert(got === 2400, `three fast presses = three reels (got ${got})`);
});

test("T-K3 typing in a field is never hijacked", async (t) => {
  const { cdp, sessionId, chrome } = await t.launch();
  await setupReelsPage(cdp, sessionId);
  await chrome.park();
  await chrome.setViewportSize(sessionId, 390, 800);
  await sleep(400);

  await evalPage(cdp, sessionId, "document.getElementById('typebox').focus(); 1");
  t.assert((await evalPage(cdp, sessionId, reelStepJs(1))) === "typing", "ArrowDown defers while typing");
  t.assert((await evalPage(cdp, sessionId, TOGGLE_PLAY_JS)) === "typing", "Space defers while typing");
  t.assert((await feedTop(cdp, sessionId)) === 0, "and the feed did not move");

  await evalPage(cdp, sessionId, "document.getElementById('typebox').blur(); 1");
  t.assert((await evalPage(cdp, sessionId, reelStepJs(1))) !== "typing", "works again once unfocused");
});

test("T-K4 Space toggles the most-centred reel", async (t) => {
  const { cdp, sessionId, chrome } = await t.launch();
  await setupReelsPage(cdp, sessionId);
  await chrome.park();
  await chrome.setViewportSize(sessionId, 390, 800);
  await sleep(500);

  t.assert((await evalPage(cdp, sessionId, TOGGLE_PLAY_JS)) === "play", "first press plays");
  t.assert((await evalPage(cdp, sessionId, TOGGLE_PLAY_JS)) === "pause", "second press pauses");

  await setFeedTop(cdp, sessionId, 2400); // reel index 3 now fills the view
  await evalPage(cdp, sessionId, TOGGLE_PLAY_JS);
  const log = await evalPage(cdp, sessionId, "window.__log.join(',')");
  t.assert(
    log === "play:0,pause:0,play:3",
    `acts on the reel that is actually on screen (log: ${log})`
  );
});

// ---- T5: window-close resurrection ---------------------------------------
test("T5 closing the window by hand re-parks the recreated one", async (t) => {
  const { cdp, sessionId, chrome } = await t.launch();
  const { windowId } = await windowBounds(cdp, chrome.pageTargetId);
  await cdp.send("Browser.closeWindow", { windowId }).catch(() => {});
  await sleep(800);
  const newSession = await chrome.recreatePage();
  await setupTestPage(cdp, newSession);
  const frames = countFrames(cdp, newSession);
  await startCast(cdp, newSession);
  await chrome.park();
  await sleep(1500);
  const { bounds } = await windowBounds(cdp, chrome.pageTargetId);
  t.assert(isParked(bounds), `recreated window is parked (left=${bounds.left})`);
  t.assert(frames.n >= 5, `recreated page streams (got ${frames.n})`);
});

// ---- T6: CDP timeout -----------------------------------------------------
test("T6 a send to a black-hole endpoint rejects instead of hanging", async (t) => {
  const started = Date.now();
  let err = null;
  try {
    await Cdp.connect("ws://127.0.0.1:9/devtools/browser/nope", 1200);
  } catch (e) {
    err = e;
  }
  const took = Date.now() - started;
  t.assert(!!err, "connect rejects rather than hanging forever");
  t.assert(took < 5000, `rejects promptly (took ${took}ms)`);
});

// ---- T7: clean kill ------------------------------------------------------
test("T7 dispose kills the browser process", async (t) => {
  const { chrome } = await t.launch();
  await sleep(500);
  await chrome.dispose();
  t.owned.delete(chrome);
  await sleep(1200);
  const alive = require("child_process")
    .execSync(`pgrep -f "user-data-dir=${t.profileDir}" || true`)
    .toString()
    .trim();
  t.assert(alive === "", `no Chrome left holding the profile (got "${alive}")`);
});

// ---- runner --------------------------------------------------------------

async function run() {
  const only = process.argv.slice(2);
  const selected = only.length
    ? tests.filter((x) => only.some((o) => x.name.startsWith(o)))
    : tests;

  let pass = 0;
  let fail = 0;
  const failures = [];

  for (const { name, fn } of selected) {
    const owned = new Set();
    const cleanupDirs = [];
    let profileDir = "";
    const checks = [];

    const t = {
      owned,
      get profileDir() {
        return profileDir;
      },
      assert(cond, label) {
        checks.push({ cond: !!cond, label });
        if (!cond) throw new Error(label);
      },
      countOverrides(cdp) {
        const state = { n: 0 };
        const orig = cdp.send.bind(cdp);
        cdp.send = (method, params, sid, timeout) => {
          if (method === "Emulation.setDeviceMetricsOverride") state.n++;
          return orig(method, params, sid, timeout);
        };
        return state;
      },
      async launch() {
        const { dir, context } = makeContext();
        cleanupDirs.push(dir);
        profileDir = path.join(dir, "profile");
        const chrome = new ChromeManager(context, { onGone: () => {} });
        owned.add(chrome);
        const { cdp, sessionId } = await chrome.connectOrLaunch();
        // Mirror instaView.setupSession(): without focus emulation a hidden
        // window produces exactly zero frames (PROGRESS finding 2).
        await cdp.send("Page.enable", {}, sessionId);
        await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId);
        return { cdp, sessionId, chrome };
      },
      async launchProvider() {
        const { dir, context } = makeContext();
        cleanupDirs.push(dir);
        profileDir = path.join(dir, "profile");
        const provider = new ReelViewProvider(context);
        owned.add(provider.chromeManager);
        const fake = makeFakeView(true);
        provider.resolveWebviewView(fake.view);
        fake.send({ type: "ready", cssW: 440, cssH: 900, dpr: 2 });
        // Wait for connect() + goLive() to finish.
        for (let i = 0; i < 100 && !provider.chromeManager.isConnected; i++) await sleep(100);
        await sleep(1200);
        const cdp = provider.chromeManager.connection;
        const sessionId = provider.sessionId;
        return { provider, fake, cdp, sessionId, chrome: provider.chromeManager };
      },
    };

    process.stdout.write(`\n▶ ${name}\n`);
    try {
      await fn(t);
      checks.forEach((c) => console.log(`    ✓ ${c.label}`));
      console.log(`  PASS`);
      pass++;
    } catch (e) {
      checks.forEach((c) => console.log(`    ${c.cond ? "✓" : "✗"} ${c.label}`));
      console.log(`  FAIL — ${e.message}`);
      failures.push(`${name}: ${e.message}`);
      fail++;
    } finally {
      for (const c of owned) {
        try {
          await c.dispose();
        } catch {}
      }
      await sleep(400);
      for (const d of cleanupDirs) {
        try {
          fs.rmSync(d, { recursive: true, force: true });
        } catch {}
      }
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`${pass}/${pass + fail} passed`);
  if (failures.length) {
    console.log("\nFailures:");
    failures.forEach((f) => console.log(`  ✗ ${f}`));
  }
  process.exit(fail ? 1 : 0);
}

run().catch((e) => {
  console.error("harness error:", e);
  process.exit(2);
});
