// Native bridge for the Capacitor app.
//
// Bundled by esbuild to web/native.bundle.js and loaded before app.js. In a
// browser this is inert (isNative = false → app.js uses the Web Speech API). In
// the native iOS/Android app it exposes window.TracyNative with NATIVE speech
// recognition + text-to-speech, which bypass Safari/WebKit's limits — that's how
// voice works reliably on iPhone.

import { Capacitor } from "@capacitor/core";
import { SpeechRecognition } from "@capacitor-community/speech-recognition";
import { TextToSpeech } from "@capacitor-community/text-to-speech";

const isNative = !!(Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform());

// ---- Speech-to-text (native) ----
let sttListening = false;

async function sttAvailable() {
  if (!isNative) return false;
  try { const r = await SpeechRecognition.available(); return !!(r && r.available); } catch { return false; }
}
async function sttRequestPermission() {
  try {
    const c = await SpeechRecognition.checkPermissions();
    if (c && c.speechRecognition === "granted") return true;
    const r = await SpeechRecognition.requestPermissions();
    return !!(r && r.speechRecognition === "granted");
  } catch { return false; }
}
// onPartial(text) as the user speaks; onEnd() when the engine stops the phrase.
async function sttStart(onPartial, onEnd) {
  try { await SpeechRecognition.removeAllListeners(); } catch {}
  await SpeechRecognition.addListener("partialResults", (data) => {
    const m = data && data.matches && data.matches[0];
    if (m) onPartial(m);
  });
  await SpeechRecognition.addListener("listeningState", (data) => {
    if (data && data.status === "stopped") { sttListening = false; if (onEnd) onEnd(); }
  });
  sttListening = true;
  try {
    const res = await SpeechRecognition.start({ language: "en-US", partialResults: true, popup: false });
    // Some platforms resolve start() with the final matches.
    const m = res && res.matches && res.matches[0];
    if (m) onPartial(m);
  } catch {
    sttListening = false; if (onEnd) onEnd();
  }
}
async function sttStop() {
  try { await SpeechRecognition.stop(); } catch {}
  try { await SpeechRecognition.removeAllListeners(); } catch {}
  sttListening = false;
}

// ---- Text-to-speech (native) ----
async function ttsSpeak(text, opts) {
  try {
    await TextToSpeech.speak({
      text,
      lang: "en-US",
      rate: (opts && opts.rate) || 1.0,
      pitch: (opts && opts.pitch) || 1.0,
      volume: 1.0,
      category: "playback",
    });
    return true;
  } catch { return false; }
}
async function ttsStop() { try { await TextToSpeech.stop(); } catch {} }

window.TracyNative = {
  isNative,
  stt: {
    available: sttAvailable,
    requestPermission: sttRequestPermission,
    start: sttStart,
    stop: sttStop,
    get listening() { return sttListening; },
  },
  tts: { speak: ttsSpeak, stop: ttsStop },
};
