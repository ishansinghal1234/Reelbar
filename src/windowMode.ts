// Legacy "window" mode: docks a REAL, chromeless Chromium window (Instagram)
// flush beside the editor. Kept as a fallback behind reelbar.mode: "window".
// This is the original v1 implementation, moved here verbatim.

import * as vscode from "vscode";
import { spawn, execFile, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { findBrowser } from "./chromeManager";

interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

let dockProc: ChildProcess | null = null;
let globalStoragePath = "";
let onStateChange: (() => void) | null = null;

export function initWindowMode(storagePath: string, onChange: () => void): void {
  globalStoragePath = storagePath;
  onStateChange = onChange;
}

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("reelbar");
}

export function isRunning(): boolean {
  return !!dockProc && dockProc.exitCode === null && !dockProc.killed;
}

// Reads the usable desktop rectangle on macOS via AppleScript.
// Resolves to a sane default off-platform or on error.
function getScreenBounds(): Promise<Bounds> {
  return new Promise((resolve) => {
    const fallback: Bounds = { x: 0, y: 0, w: 1440, h: 900 };
    if (process.platform !== "darwin") return resolve(fallback);
    execFile(
      "osascript",
      ["-e", 'tell application "Finder" to get bounds of window of desktop'],
      { timeout: 3000 },
      (err, stdout) => {
        if (err || !stdout) return resolve(fallback);
        const [x, y, w, h] = stdout.split(",").map((s) => parseInt(s.trim(), 10));
        if ([x, y, w, h].some(Number.isNaN)) return resolve(fallback);
        resolve({ x, y, w, h });
      }
    );
  });
}

async function computeDock(): Promise<{ left: number; top: number; width: number; height: number }> {
  const c = cfg();
  const side = c.get<string>("dockSide", "right");
  const width = c.get<number>("width", 440);
  const topOffset = c.get<number>("menuBarOffset", 25);
  const s = await getScreenBounds();
  const w = Math.min(width, s.w);
  const left = side === "right" ? s.x + s.w - w : s.x;
  const top = s.y + topOffset;
  const height = Math.max(200, s.h - topOffset);
  return { left, top, width: w, height };
}

function bringToFront(pid: number): void {
  if (process.platform !== "darwin") return;
  execFile(
    "osascript",
    ["-e", `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`],
    () => {}
  );
}

export async function openDock(): Promise<void> {
  if (isRunning()) {
    // Already open — surface it instead of spawning a duplicate.
    if (dockProc?.pid) bringToFront(dockProc.pid);
    return;
  }

  const bin = findBrowser();
  if (!bin) {
    vscode.window.showErrorMessage(
      "Reelbar: no Chromium browser found. Set reelbar.browserPath to a Chrome/Brave/Edge binary."
    );
    return;
  }

  const profileDir = path.join(globalStoragePath, "profile");
  try {
    fs.mkdirSync(profileDir, { recursive: true });
  } catch {
    /* ignore */
  }

  const url = cfg().get<string>("url", "https://www.instagram.com/");
  const d = await computeDock();

  const args = [
    `--app=${url}`,
    `--user-data-dir=${profileDir}`,
    `--window-position=${d.left},${d.top}`,
    `--window-size=${d.width},${d.height}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate",
  ];

  dockProc = spawn(bin, args, { stdio: "ignore" });
  dockProc.on("error", (e: Error) => {
    vscode.window.showErrorMessage("Reelbar: failed to launch browser — " + e.message);
    dockProc = null;
    onStateChange?.();
  });
  dockProc.on("exit", () => {
    dockProc = null;
    onStateChange?.();
  });
  onStateChange?.();
}

export function closeDock(): void {
  if (isRunning() && dockProc) {
    const proc = dockProc;
    try {
      proc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    // Force-kill if it hasn't exited shortly after.
    setTimeout(() => {
      if (proc.exitCode === null && !proc.killed) {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }, 1500);
  }
  dockProc = null;
  onStateChange?.();
}

export function toggleDock(): void {
  if (isRunning()) {
    closeDock();
  } else {
    void openDock();
  }
}

// Re-snap: close and reopen at freshly-computed bounds. The profile persists,
// so this only reloads the page — login and session are untouched.
export async function redock(): Promise<void> {
  if (!isRunning()) return void openDock();
  closeDock();
  setTimeout(() => void openDock(), 400);
}
