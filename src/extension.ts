// Reelbar — Instagram beside your code.
//
// Sidebar mode (default): a real, headful Chrome runs with its window parked
// offscreen (audio still plays) and is mirrored into a VS Code sidebar view
// via CDP screencast. Instagram sees a completely normal browser — no iframe,
// no proxy, no automation flags.
//
// Window mode (legacy fallback): docks a chromeless browser window flush
// beside the editor. See windowMode.ts.

import * as vscode from "vscode";
import { ReelViewProvider } from "./reelView";
import * as windowMode from "./windowMode";

let statusItem: vscode.StatusBarItem | null = null;
let provider: ReelViewProvider | null = null;

function mode(): string {
  return vscode.workspace.getConfiguration("reelbar").get<string>("mode", "sidebar");
}

function updateStatus(): void {
  if (!statusItem) return;
  const active = mode() === "sidebar" ? !!provider?.chromeManager.isConnected : windowMode.isRunning();
  if (active) {
    statusItem.text = "$(circle-filled) Reels";
    statusItem.tooltip = "Reelbar: running — click to toggle (⌘⇧9)";
  } else {
    statusItem.text = "$(device-camera-video) Reels";
    statusItem.tooltip = "Reelbar: open Instagram (⌘⇧9)";
  }
  statusItem.show();
}

async function toggle(): Promise<void> {
  if (mode() === "window") {
    windowMode.toggleDock();
    return;
  }
  // Sidebar mode: reveal the view (spawns Chrome lazily on first open); if
  // it's already the visible view, collapse the sidebar instead.
  if (provider?.isVisible) {
    await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar").then(
      () => undefined,
      () => undefined
    );
    await vscode.commands.executeCommand("workbench.action.closeSidebar").then(
      () => undefined,
      () => undefined
    );
  } else {
    await vscode.commands.executeCommand("reelbar.view.focus");
  }
  updateStatus();
}

async function open(): Promise<void> {
  if (mode() === "window") return windowMode.openDock();
  await vscode.commands.executeCommand("reelbar.view.focus");
}

async function close(): Promise<void> {
  if (mode() === "window") return windowMode.closeDock();
  await provider?.shutdown();
  updateStatus();
}

export function activate(context: vscode.ExtensionContext): void {
  windowMode.initWindowMode(context.globalStorageUri.fsPath, updateStatus);

  provider = new ReelViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ReelViewProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = "reelbar.toggle";
  context.subscriptions.push(statusItem);
  updateStatus();

  // The persona and start page are baked into the browser session, so a
  // running browser keeps the old value until it restarts. Silently ignoring
  // the change is what made these settings feel broken.
  const RESTART_SETTINGS = ["reelbar.mobileUI", "reelbar.url"];
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (mode() !== "sidebar" || !provider?.chromeManager.isConnected) return;
      if (e.affectsConfiguration("reelbar.quality")) await provider.applyQuality();
      if (e.affectsConfiguration("reelbar.reelHeight")) provider.refit();
      const changed = RESTART_SETTINGS.find((s) => e.affectsConfiguration(s));
      if (!changed) return;
      const pick = await vscode.window.showInformationMessage(
        `Reelbar: restart the browser to apply ${changed.replace("reelbar.", "")}.`,
        "Restart Browser"
      );
      if (pick === "Restart Browser") await provider.restartChrome();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("reelbar.toggle", () => void toggle()),
    vscode.commands.registerCommand("reelbar.open", () => void open()),
    vscode.commands.registerCommand("reelbar.close", () => void close()),
    vscode.commands.registerCommand("reelbar.redock", () => void windowMode.redock()),
    vscode.commands.registerCommand("reelbar.showBrowserWindow", () =>
      provider ? void provider.showBrowserWindow() : undefined
    ),
    vscode.commands.registerCommand("reelbar.hideBrowserWindow", () =>
      provider ? void provider.hideBrowserWindow() : undefined
    ),
    vscode.commands.registerCommand("reelbar.restartChrome", () =>
      provider ? void provider.restartChrome() : undefined
    ),
    vscode.commands.registerCommand("reelbar.reload", () =>
      provider ? void provider.reloadPage() : undefined
    )
  );
}

export function deactivate(): Promise<void> | void {
  // Tear everything down so we don't orphan an invisible Chrome eating CPU.
  windowMode.closeDock();
  const p = provider?.dispose();
  provider = null;
  return p;
}
