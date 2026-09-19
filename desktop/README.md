# Tracy Desktop

Tracy runs in the cloud. **Tracy Desktop makes this PC her hands**: it runs
her task runner in the background (so "have the agent fix X" actually
happens, with Claude Code on your subscription), gives Claude Code her tools
over MCP, installs the Interverse skills, and opens her chat in a window.
It lives in the system tray.

No git, no npm, no terminal — download, install, fill in a form.

## Download

Installers are on the [Releases page](https://github.com/FabianB14/tracy-ai/releases)
(tags `desktop-v*`): a `.exe` for Windows, a `.dmg` for macOS.

Builds are **unsigned** for now, so the OS warns once:
- Windows: "Windows protected your PC" → *More info* → *Run anyway*.
- macOS: right-click the app → *Open* the first time.

Signing (no warning) needs a paid certificate — worth it when Tracy ships to
studios, not for our own machines.

## First run

1. **Settings** opens. Fill in:
   - Tracy's URL (her Render service).
   - Tracy's **database URL** — Render → the Postgres → Connect → *External
     Database URL*. This is the task queue, so it's required.
   - A **GitHub token** — fine-grained, *Only select repositories*, with
     **Contents** and **Pull requests** read/write.
   - The **repos** Tracy may work on — paste GitHub URLs, one per line.
     The runner clones fresh per task and works on `tracy/task-N` branches.
   - For the tools: the Interverse API URL, the admin key
     (`ADMIN_REGISTRATION_KEY`), and your Tracy admin userId.
   - Gemini key is optional (lets finished tasks be saved to her memory).

   Secrets go into the OS keychain where available. Nothing leaves this PC.

2. **Status & setup** shows a checklist:
   - **Install Claude Code** — the one thing the app can't do for you.
     The button opens the install page; it's a one-line installer.
   - **Log in (once)** — opens a terminal running `claude`. Sign in with
     your Claude account, type `/exit`. This is what puts tasks on your
     subscription instead of an API bill.
   - **Install skills** — one click. Copies `tracy-dev`,
     `interverse-platform`, `interverse-unreal`, `interverse-unity` into
     `~/.claude/skills`, so delegated work already knows the stack.
   - **Register MCP** — one click. Adds `tracy-tools` to Claude Code's
     config (`~/.claude.json`), pointing at the bundled server, so a task
     can make a test kit or flip a platform switch mid-work.

3. **Start runner.** The tray shows it running. Then in Tracy:

   > Have the agent add a "How conversion works" section to the SDK's
   > docs/ASSET-INTERCHANGE.md, matching decision #18.

   Watch the log. Ask her *"what's the status of that task?"* — you get the
   summary, cost, and a PR link.

The runner starts automatically on later launches, and the app can start
with your sign-in (Settings). Closing windows leaves it in the tray; *Quit*
is in the tray menu.

## Updating

The status window has **Check for updates** (the app also checks quietly
on launch and every six hours). When a newer release exists:

- **Windows:** *Download update* → *Restart to update*. It installs in
  place; settings, skills, and the Claude Code login are untouched.
- **macOS:** the button opens the download page — in-place updates need a
  signed app, and ours is unsigned. Drag the new one over the old.

Installing a newer `.exe`/`.dmg` by hand also upgrades in place, for the
same reason: same app id, and everything personal lives outside the app
folder.

The feed is GitHub's *latest release* redirect (`releases/latest/download/
latest.yml`), so cutting a release is the whole publish step — any tag name
works, no tokens involved.

## How it's built

- `main.js` — tray, windows, IPC. `lib/runner.js` manages the runner child
  process (crash-loop guard: five crashes in ten minutes stops it and says
  so). `lib/setup.js` finds Claude Code, installs skills, registers MCP.
  `lib/config.js` is the settings store; secrets via `safeStorage`.
- The app ships a **staged copy of Tracy's runtime** (`src`, `scripts`,
  `mcp`, `skills`, production `node_modules`) under `resources/tracy`, and
  runs it with Electron's bundled Node (`ELECTRON_RUN_AS_NODE`). That's why
  no Node install is needed. `npm run stage` builds that copy.
- The four skills: `tracy-dev` from this repo, the three `interverse-*`
  vendored from InterverseSDK (`npm run sync-skills` refreshes them).
- Installers come from `.github/workflows/desktop.yml`: push a tag like
  `desktop-v0.1.0` and the Windows and macOS builds land on a Release.

## Developing

```bash
npm install            # in the repo root (staged deps come from here)
cd desktop && npm install
npm test               # config, setup, runner-manager tests (plain Node)
npm start              # run from source (uses ../ as Tracy's root)
npm run dist:win       # or dist:mac — local installer build
```

## What it does NOT do

- It does not run a model. Tasks run in Claude Code; chat runs on Tracy's
  server. This app is plumbing.
- It cannot log Claude Code in for you — that browser login is yours, once.
- It does not touch `main`/`master`: the runner only pushes `tracy/task-N`
  branches and opens PRs.
