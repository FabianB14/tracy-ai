# Tracy as a native app (Android + iOS) via Capacitor

The web app (`web/`) is wrapped with [Capacitor](https://capacitorjs.com) into
real native apps. Inside the app, Tracy uses **native speech recognition and
text-to-speech** instead of the browser's Web Speech API — so **voice works
reliably on iPhone and Android** (Safari/WebKit can't do mic input; the native
app can).

Same code everywhere:
- **Browser** (GitHub Pages / Vercel / the Render URL) → Web Speech API.
- **Native app** → native voice via `web/native/bridge.js` (`window.TracyNative`).

The app talks to the same backend (`https://tracy-ai.onrender.com`) as the web.

## Prerequisites
- Node 18+ (`npm install` in this repo).
- **Android:** Android Studio + a JDK (17). Builds on any OS.
- **iOS:** a **Mac** with Xcode + CocoaPods (`sudo gem install cocoapods`). iOS
  can only be built on macOS.

## One-time setup
```bash
npm install
npm run native:bundle          # builds web/native.bundle.js from web/native/bridge.js
npx cap add android            # creates android/  (run on any OS)
npx cap add ios                # creates ios/      (macOS only)
npx cap sync
```

## Permissions (required — without them iOS crashes and Android mic fails)

**Android** — `android/app/src/main/AndroidManifest.xml`, inside `<manifest>`:
```xml
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.INTERNET" />
```

**iOS** — `ios/App/App/Info.plist`, add these keys:
```xml
<key>NSMicrophoneUsageDescription</key>
<string>Tracy uses the microphone so you can talk to her.</string>
<key>NSSpeechRecognitionUsageDescription</key>
<string>Tracy uses speech recognition to understand what you say.</string>
```

## Run it
```bash
npx cap open android     # opens Android Studio → Run ▶ on a device/emulator
npx cap open ios         # opens Xcode → select a device → Run ▶
```
Grant the mic/speech permission prompts on first launch, then tap the mic 🎤.

## Updating after web changes
When you change anything in `web/`, refresh the native apps:
```bash
npm run native:sync      # rebuilds the bundle + npx cap sync
```
then rebuild in Android Studio / Xcode.

### Tip: skip rebuilding on every UI change
If you'd rather the app always load the **live** UI from Render (so you only
rebuild when native bits change), add a `server` block to `capacitor.config.json`:
```json
{ "server": { "url": "https://tracy-ai.onrender.com", "cleartext": false } }
```
Then `npx cap sync`. The app loads the deployed site (which already includes
`native.bundle.js`), and the native voice plugins still work because Capacitor
injects them into the WebView regardless of the URL. Remove the block to go back
to shipping the bundled `web/` assets (works offline).

## Notes
- `android/` and `ios/` are generated locally and are gitignored — don't commit them.
- The app still shows the **access-key gate** if the backend requires one.
- App id / name live in `capacitor.config.json` (`com.interverse.tracy` / "Tracy").
- iOS/Android **native voices** differ from the browser's; the in-app voice
  picker and rate/pitch still apply. For per-platform voice tuning, adjust
  `web/native/bridge.js`.
