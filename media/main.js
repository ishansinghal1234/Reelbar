// Reelbar webview: draws screencast frames onto the canvas and forwards
// input to the extension, which replays it into Chrome over CDP.
(function () {
  const vscode = acquireVsCodeApi();
  const canvas = document.getElementById("screen");
  const ctx = canvas.getContext("2d");
  const overlay = document.getElementById("overlay");
  const overlayMsg = document.getElementById("overlay-msg");
  const overlayBtn = document.getElementById("overlay-btn");

  const post = (m) => vscode.postMessage(m);

  // ---- frame rendering: latest-wins, never queue more than one decode ----
  let pendingFrame = null;
  let drawing = false;
  const canDecodeBitmap = typeof createImageBitmap === "function";

  function paint(src, w, h) {
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    ctx.drawImage(src, 0, 0);
  }

  async function drawLatest() {
    if (drawing || !pendingFrame) return;
    drawing = true;
    const data = pendingFrame;
    pendingFrame = null;
    try {
      // Binary path (extension sends raw JPEG bytes): decodes off the main
      // thread and skips the base64 data-URL string entirely.
      if (canDecodeBitmap && typeof data !== "string") {
        const bitmap = await createImageBitmap(new Blob([data], { type: "image/jpeg" }));
        try {
          paint(bitmap, bitmap.width, bitmap.height);
        } finally {
          bitmap.close();
        }
      } else {
        // Fallback: base64 string via an <img> (older hosts, or if
        // createImageBitmap is unavailable).
        const img = new Image();
        img.src =
          typeof data === "string"
            ? "data:image/jpeg;base64," + data
            : URL.createObjectURL(new Blob([data], { type: "image/jpeg" }));
        await img.decode();
        paint(img, img.width, img.height);
        if (img.src.startsWith("blob:")) URL.revokeObjectURL(img.src);
      }
    } catch (e) {
      /* skip bad frame */
    }
    drawing = false;
    if (pendingFrame) drawLatest();
  }

  // ---- overlay states ----
  let overlayAction = null;

  function showOverlay(msg, btnLabel, action) {
    overlayMsg.textContent = msg;
    if (btnLabel) {
      overlayBtn.textContent = btnLabel;
      overlayBtn.hidden = false;
      overlayAction = action;
    } else {
      overlayBtn.hidden = true;
      overlayAction = null;
    }
    overlay.hidden = false;
  }

  function hideOverlay() {
    overlay.hidden = true;
    overlayAction = null;
  }

  overlayBtn.addEventListener("click", () => {
    if (overlayAction) post({ type: overlayAction });
  });

  function applyState(state, detail) {
    switch (state) {
      case "connecting":
        showOverlay(detail || "Starting browser…", null, null);
        break;
      case "live":
        hideOverlay();
        break;
      case "loginNeeded":
        showOverlay(
          detail || "Log in in a real browser window — it only takes once.",
          "Open login window",
          "showWindow"
        );
        break;
      case "windowShown":
        showOverlay(
          "The browser window is open on your screen. Finish up, then come back.",
          "I'm done — hide it",
          "hideWindow"
        );
        break;
      case "chromeDead":
        showOverlay("The browser closed.", "Reopen", "reconnect");
        break;
      case "error":
        showOverlay(detail || "Something went wrong.", "Retry", "reconnect");
        break;
    }
  }

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m.type === "frame") {
      pendingFrame = m.data;
      drawLatest();
    } else if (m.type === "state") {
      applyState(m.state, m.detail);
    }
  });

  // ---- input capture ----
  function mods(e) {
    return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
  }

  // Map a pointer event to 0..1 coords WITHIN the drawn frame. The canvas
  // uses object-fit: contain, so when the frame's aspect ratio briefly
  // differs from the sidebar's, the image occupies a centered sub-rect.
  function norm(e) {
    const r = canvas.getBoundingClientRect();
    let ix = r.left, iy = r.top, iw = r.width, ih = r.height;
    if (canvas.width > 0 && canvas.height > 0 && r.width > 0 && r.height > 0) {
      const scale = Math.min(r.width / canvas.width, r.height / canvas.height);
      iw = canvas.width * scale;
      ih = canvas.height * scale;
      ix = r.left + (r.width - iw) / 2;
      iy = r.top + (r.height - ih) / 2;
    }
    return {
      nx: Math.min(1, Math.max(0, (e.clientX - ix) / iw)),
      ny: Math.min(1, Math.max(0, (e.clientY - iy) / ih)),
    };
  }

  // Wheel events fire 60-120/s on a trackpad; one CDP round-trip each would
  // flood the socket and compete with frame acks. Sum the deltas and flush
  // once per ~frame. A timer, not requestAnimationFrame: rAF is throttled or
  // paused when the webview is occluded, which would strand a gesture.
  let wheelAcc = null;
  let wheelTimer = null;

  function flushWheel() {
    if (wheelTimer) {
      clearTimeout(wheelTimer);
      wheelTimer = null;
    }
    if (!wheelAcc) return;
    const w = wheelAcc;
    wheelAcc = null;
    post({ type: "mouse", kind: "wheel", nx: w.nx, ny: w.ny, dx: w.dx, dy: w.dy });
  }

  canvas.addEventListener("mousedown", (e) => {
    canvas.focus();
    flushWheel(); // ordering: a pending scroll must land before the click
    post({
      type: "mouse", kind: "down", ...norm(e),
      button: e.button, clickCount: e.detail || 1, mods: mods(e),
    });
  });

  canvas.addEventListener("mouseup", (e) => {
    flushWheel();
    post({
      type: "mouse", kind: "up", ...norm(e),
      button: e.button, clickCount: e.detail || 1, mods: mods(e),
    });
  });

  let lastMove = 0;
  canvas.addEventListener("mousemove", (e) => {
    const now = Date.now();
    if (now - lastMove < 33) return; // ~30/s
    lastMove = now;
    post({ type: "mouse", kind: "move", ...norm(e) });
  });

  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const n = norm(e);
      // Coordinates come from the newest event in the batch; deltas accumulate
      // so the page still receives the gesture's full scroll distance.
      if (wheelAcc) {
        wheelAcc.dx += e.deltaX;
        wheelAcc.dy += e.deltaY;
        wheelAcc.nx = n.nx;
        wheelAcc.ny = n.ny;
      } else {
        wheelAcc = { dx: e.deltaX, dy: e.deltaY, nx: n.nx, ny: n.ny };
      }
      if (!wheelTimer) wheelTimer = setTimeout(flushWheel, 16);
    },
    { passive: false }
  );

  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  function isPrintable(e) {
    return e.key.length === 1 && !e.ctrlKey && !e.metaKey;
  }

  canvas.addEventListener("keydown", (e) => {
    if (isPrintable(e)) return; // arrives via keypress → insertText
    if (e.metaKey || e.ctrlKey) return; // let VS Code keep its chords
    e.preventDefault();
    flushWheel();
    post({ type: "key", kind: "down", key: e.key, code: e.code, mods: mods(e) });
  });

  canvas.addEventListener("keyup", (e) => {
    if (isPrintable(e) || e.metaKey || e.ctrlKey) return;
    post({ type: "key", kind: "up", key: e.key, code: e.code, mods: mods(e) });
  });

  canvas.addEventListener("keypress", (e) => {
    e.preventDefault();
    if (e.key.length === 1) {
      flushWheel();
      post({ type: "text", text: e.key });
    }
  });

  // Cmd+V routes here; password managers work via clipboard.
  document.addEventListener("paste", (e) => {
    const text = e.clipboardData && e.clipboardData.getData("text");
    if (text) {
      flushWheel();
      post({ type: "text", text });
    }
  });

  // ---- size reporting (debounce lives extension-side) ----
  function report(type) {
    post({
      type,
      cssW: Math.max(1, Math.round(canvas.clientWidth || document.body.clientWidth)),
      cssH: Math.max(1, Math.round(canvas.clientHeight || document.body.clientHeight)),
      dpr: window.devicePixelRatio || 1,
    });
  }

  new ResizeObserver(() => report("resize")).observe(document.body);
  report("ready");
})();
