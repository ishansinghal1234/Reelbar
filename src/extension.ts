// Reelbar — browse Instagram, YouTube Music, and Slack beside your code.
//
// Sidebar mode (default): a real, headful Chrome runs with its window parked
// offscreen (audio still plays) and is mirrored into a VS Code sidebar view
// via CDP screencast. Each panel gets its own Chrome instance and profile.
//
// Window mode (legacy fallback): docks a chromeless browser window flush
// beside the editor. See windowMode.ts.

import * as vscode from "vscode";
import { ReelViewProvider } from "./reelView";
import * as windowMode from "./windowMode";

let statusItem: vscode.StatusBarItem | null = null;
let providers: ReelViewProvider[] = [];

const PANELS = [
  { viewId: "reelbar.view.instagram", source: "instagram" },
  { viewId: "reelbar.view.ytmusic",   source: "ytmusic"   },
  { viewId: "reelbar.view.slack",     source: "slack"     },
] as const;

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("reelbar");
}

function mode(): string {
  return cfg().get<string>("mode", "sidebar");
}

function updateStatus(): void {
  if (!statusItem) return;
  const active = mode() === "sidebar"
    ? providers.some((p) => p.chromeManager.isConnected)
    : windowMode.isRunning();
  if (active) {
    statusItem.text = "$(circle-filled) Reelbar";
    statusItem.tooltip = "Reelbar: running — click to toggle (⌘⇧9)";
  } else {
    statusItem.text = "$(device-camera-video) Reelbar";
    statusItem.tooltip = "Reelbar: open (⌘⇧9)";
  }
  statusItem.show();
}

async function toggle(): Promise<void> {
  if (mode() === "window") {
    windowMode.toggleDock();
    return;
  }
  if (providers.some((p) => p.isVisible)) {
    await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar").then(
      () => undefined,
      () => undefined
    );
    await vscode.commands.executeCommand("workbench.action.closeSidebar").then(
      () => undefined,
      () => undefined
    );
  } else {
    await vscode.commands.executeCommand("reelbar.view.instagram.focus");
  }
  updateStatus();
}

async function open(): Promise<void> {
  if (mode() === "window") return windowMode.openDock();
  await vscode.commands.executeCommand("reelbar.view.instagram.focus");
}

async function close(): Promise<void> {
  if (mode() === "window") return windowMode.closeDock();
  await Promise.all(providers.map((p) => p.shutdown()));
  updateStatus();
}

export function activate(context: vscode.ExtensionContext): void {
  windowMode.initWindowMode(context.globalStorageUri.fsPath, updateStatus);

  providers = PANELS.map((p) => new ReelViewProvider(context, p.viewId, p.source));
  for (const p of providers) {
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(p.viewId, p, {
        webviewOptions: { retainContextWhenHidden: true },
      })
    );
  }

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = "reelbar.toggle";
  context.subscriptions.push(statusItem);
  updateStatus();

  const RESTART_SETTINGS = ["reelbar.mobileUI", "reelbar.url"];
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (mode() !== "sidebar") return;
      for (const p of providers) {
        if (!p.chromeManager.isConnected) continue;
        if (e.affectsConfiguration("reelbar.quality")) await p.applyQuality();
        if (e.affectsConfiguration("reelbar.reelHeight")) p.refit();
      }
      const changed = RESTART_SETTINGS.find((s) => e.affectsConfiguration(s));
      if (!changed) return;
      const running = providers.filter((p) => p.chromeManager.isConnected);
      if (!running.length) return;
      const pick = await vscode.window.showInformationMessage(
        `Reelbar: restart browser(s) to apply ${changed.replace("reelbar.", "")}.`,
        "Restart All"
      );
      if (pick === "Restart All") await Promise.all(running.map((p) => p.restartChrome()));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("reelbar.toggle", () => void toggle()),
    vscode.commands.registerCommand("reelbar.open",   () => void open()),
    vscode.commands.registerCommand("reelbar.close",  () => void close()),
    vscode.commands.registerCommand("reelbar.redock", () => void windowMode.redock()),
    vscode.commands.registerCommand("reelbar.showBrowserWindow", () => {
      const p = providers.find((p) => p.isVisible) ?? providers[0];
      return p ? void p.showBrowserWindow() : undefined;
    }),
    vscode.commands.registerCommand("reelbar.hideBrowserWindow", () => {
      const p = providers.find((p) => p.isVisible) ?? providers[0];
      return p ? void p.hideBrowserWindow() : undefined;
    }),
    vscode.commands.registerCommand("reelbar.restartChrome", () =>
      void Promise.all(providers.map((p) => p.restartChrome()))
    ),
    vscode.commands.registerCommand("reelbar.reload", () =>
      void Promise.all(
        providers.filter((p) => p.chromeManager.isConnected).map((p) => p.reloadPage())
      )
    )
  );
}

export function deactivate(): Promise<void> | void {
  windowMode.closeDock();
  const all = providers.map((p) => p.dispose());
  providers = [];
  return Promise.all(all).then(() => {});
}
