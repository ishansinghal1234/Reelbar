# Reelbar

**Instagram reels in your VS Code sidebar.** Scroll reels beside your code while the build runs or your agent grinds away — audio and all.

Not an iframe, not a proxy. A real Chrome runs with its window parked out of sight and its pixels streamed into the sidebar, so Instagram sees a completely normal browser session.

---

## Install

Reelbar isn't on the Marketplace yet, so you build it yourself. It takes about a minute.

**You need first:** [Node.js](https://nodejs.org) 18+, VS Code 1.80+, and a Chromium browser (Chrome, Brave, Edge or Chromium — auto-detected).

Download the source ([ZIP](https://github.com/Tyagi221B/Reelbar/archive/refs/heads/main.zip) or `git clone`), open a terminal **in that folder**, and run:

```bash
npm install
npm run package
```

That produces `reelbar-2.0.0.vsix` in the folder. Install it:

```bash
code --install-extension reelbar-2.0.0.vsix
```

On Windows, if `code` isn't recognised, use VS Code instead: **Extensions** → `···` menu → **Install from VSIX…** → pick the file.

Then **fully quit and reopen VS Code** (`⌘Q` / close every window — not "Reload Window").

> The `.vsix` is not committed to the repo, so downloading the source ZIP alone won't give you one — `npm run package` is what builds it.

**Platform support**

- **macOS** — primary target, fully tested.
- **Windows / Linux** — the extension runs, but window parking is macOS-tuned and untested elsewhere. The hidden browser window may be visible or behave oddly, and the "Close it and retry" recovery for a stuck profile lock is macOS-only. Reports welcome.

## First run

1. Click the **Reelbar icon** in the activity bar, or press **`⌘⇧9`** (`Ctrl+Shift+9` on Windows/Linux).
2. Chrome starts in the background. The first launch takes a few seconds.
3. Instagram will ask you to log in. The sidebar shows an **"Open login window"** button — click it and the real Chrome window comes to the front.
4. Log in normally: password manager, 2FA, captcha, whatever it asks for.
5. Click **"I'm done — hide it"**. The window parks itself again.

You do this once. The session lives in its own browser profile and persists.

Logging in through the real window is deliberate: Reelbar never handles your password, and Instagram sees an ordinary browser rather than an automated one.

## Controls

| Key | What it does |
|---|---|
| `⌘⇧9` | Show / hide the sidebar |
| `↑` `↓` | Previous / next reel — one full reel per press |
| `Space` | Play / pause |
| Scroll | Free-scroll the feed |
| Click | Like, follow, comment — everything works |

Arrow keys and `Space` step aside automatically while you're typing in a comment or search box.

**Tip:** drag the Reelbar view into the **secondary sidebar** (the right-hand panel) so reels sit beside your code while the file tree stays open.

## Turning it off

- **`⌘⇧9`** hides the view. The browser stays alive so audio keeps playing — podcast mode. The video stream stops while hidden, so it costs almost nothing.
- The **⏹ stop button** in the view's title bar shuts the browser down completely: stream, audio, process, gone.
- Set `reelbar.muteWhenHidden` to `true` if you'd rather it go quiet when hidden.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `reelbar.mobileUI` | `true` | Presents the browser as a phone so Instagram serves full-bleed reels, one per screen. Restart the browser after changing |
| `reelbar.reelHeight` | `844` | Caps the emulated phone height so only one reel fits. Applies immediately |
| `reelbar.quality` | `70` | JPEG quality of the stream, 30–100. Higher is sharper and costs more CPU |
| `reelbar.muteWhenHidden` | `false` | Mute when the sidebar is hidden |
| `reelbar.url` | Instagram home | The page to open — point it anywhere |
| `reelbar.browserPath` | auto | Path to a specific Chromium binary |
| `reelbar.mode` | `sidebar` | `window` docks a separate chromeless window instead (legacy) |

Because `reelbar.url` is just a setting, this doubles as an **"any site in your sidebar"** tool. Instagram is only the default.

## Commands

All under the `Reelbar:` prefix in the Command Palette.

| Command | What it does |
|---|---|
| `Toggle Instagram` | Show / hide the sidebar (`⌘⇧9`) |
| `Reload Page` | Reload Instagram |
| `Show Browser Window` | Bring the real Chrome onscreen for login / captcha / 2FA |
| `Hide Browser Window` | Park it offscreen again |
| `Restart Browser` | Kill and relaunch the hidden Chrome |
| `Close Instagram` | Shut the browser down entirely |

## Troubleshooting

**Stuck on "Starting browser…"** — no Chromium browser was found. Install Chrome, or set `reelbar.browserPath` to your binary.

**"Another Chrome window is using the profile"** — an older session is holding the profile lock. Take the "Close it and retry" option in the prompt.

**Instagram keeps asking me to log in** — run `Reelbar: Show Browser Window` and finish the verification there. Instagram is suspicious of new profiles; once verified it sticks.

**Two reels on screen at once** — check that `reelbar.mobileUI` is `true`, then restart the browser. The desktop layout cannot fit exactly one reel in a narrow sidebar; [PROGRESS.md](PROGRESS.md) has the measured reason.

**The picture is letterboxed** — that is the cost of pinning to one reel. Raise `reelbar.reelHeight` to fill more of the sidebar, at the price of the next reel peeking in.

## Why not an iframe?

Instagram sends `X-Frame-Options: DENY`, so it cannot render inside a VS Code webview at all — and a header-stripping proxy breaks login while making you look *more* like a bot. Running a real browser and streaming its pixels avoids both problems. No scraping, no proxy, one dependency (`ws`).

## How it works

1. Spawns Chrome with `--remote-debugging-port=0` and a persistent profile — **without** `--enable-automation`, so `navigator.webdriver` stays `false`.
2. Attaches over the DevTools Protocol and starts `Page.startScreencast`; JPEG frames stream to a canvas in the sidebar.
3. Parks the window as a near-offscreen sliver. Frames and audio keep flowing because the window is never actually minimized.
4. Forwards mouse, wheel, and keyboard input back through `Input.*`, and matches the page to the sidebar with viewport emulation.
5. Stops the stream while the view is hidden and resumes it, correctly sized, when you return.

## Develop

```bash
npm install
npm run compile
npm run smoke      # 22 tests against a real Chrome, throwaway profile
npm run package    # build the .vsix
```

Press **F5** to launch an Extension Development Host with Reelbar loaded.

The smoke suite drives the compiled code against a real browser with the `vscode` module stubbed — it is the only way to verify the screencast and window-parking behaviour, which follows a lot of non-obvious empirical rules. **Read [PROGRESS.md](PROGRESS.md) before changing `chromeManager.ts`:** it records constraints that are easy to break and expensive to rediscover.

## License

MIT — see [LICENSE](LICENSE).
