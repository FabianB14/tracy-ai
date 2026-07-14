# Tracy Frontend — voice-enabled PWA

A dependency-free static web app: a futuristic chat window with **microphone
input** (speech-to-text) and **Tracy speaking her replies** with live
word-highlighted captions. One codebase, many targets:

- **Web** → GitHub Pages / Vercel (static hosting)
- **Desktop app** → installable PWA today; Tauri/Electron wrap later
- **Android / iOS** → wrap with Capacitor (no rewrite)

It talks to Tracy's backend (`/chat`) — the same API every Interverse surface uses.

## Files
```
web/
├── index.html            # UI shell
├── styles.css            # futuristic theme (self-contained, no external assets)
├── app.js                # chat + mic (STT) + voice (TTS) + captions
├── config.js             # default backend URL & surface (override in Settings ⚙)
├── manifest.webmanifest  # PWA metadata (installable)
├── sw.js                 # service worker (offline shell)
└── icon.svg              # app icon
```

## Configure the backend
Edit `config.js` (`backendUrl`) or set it at runtime in **Settings (⚙)** — it's
saved to `localStorage`, so the same build can point at any deployment. Default:
`https://tracy-ai.onrender.com`.

> The backend must allow the frontend's origin via CORS. The server already
> sends permissive CORS by default; set `CORS_ORIGINS` on Render to an allowlist
> (e.g. your Pages/Vercel URLs) for production.

## Run locally
Any static server from the `web/` folder, e.g.:
```bash
npx serve web        # or: python3 -m http.server -d web 8080
```
Open the URL in **Chrome or Edge** (desktop or Android) for full voice support.

> **Voice/browser support:** mic input uses the Web Speech API (`SpeechRecognition`)
> — supported in Chrome/Edge and Chrome on Android; not in Firefox, and only
> partially on iOS Safari (that's why iOS gets a Capacitor plugin later). Tracy's
> spoken output (`speechSynthesis`) works widely. The mic button auto-disables
> where STT isn't available; typing always works. Mic/voice require HTTPS (Pages
> and Vercel are HTTPS).

## Deploy

### GitHub Pages
1. Repo → **Settings → Pages** → Source: deploy from branch → `main` → `/root`
   (or point it at the `web/` folder if you use a `/docs`-style setup).
   Simplest: keep the app at `web/` and use a Pages action, or move `web/`'s
   contents to a `gh-pages` branch root. All paths here are **relative**, so it
   works from a project subpath (`user.github.io/tracy-ai/`).
2. Set your `backendUrl` in `config.js` (or Settings) to the Render URL.

### Vercel
1. Import the repo. Framework preset: **Other**. Root directory: `web`.
   Build command: none. Output directory: `.` (it's static).
2. Deploy → you get an HTTPS URL.

## Wrap as native apps (later, same code)

### Android / iOS — Capacitor
```bash
npm i -D @capacitor/cli @capacitor/core
npx cap init Tracy com.interverse.tracy --web-dir web
npx cap add android      # and later: npx cap add ios
npx cap sync
npx cap open android     # build/run in Android Studio
```
For iOS voice input, add a Capacitor speech-recognition plugin (native STT)
since Safari's Web Speech support is limited.

### Desktop — Tauri (lightweight) or Electron
Point the wrapper at the `web/` folder (or the deployed URL). Tauri gives a small
native binary for Windows/macOS/Linux from the same web assets.

## PWA install (no wrapping needed)
Open the deployed site in Chrome/Edge → **Install app** (address bar / menu).
On Android Chrome → **Add to Home screen**. It runs full-screen like a native app.
