// Tracy frontend logic — chat + voice.
// Vanilla JS, no build step. Talks to Tracy's backend /chat endpoint, keeps
// conversation history client-side, does speech-to-text (mic) and text-to-speech
// (Tracy speaks, with live word-highlighted captions).

(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const cfgDefaults = window.TRACY_CONFIG || {};

  // ---- Settings (persisted) ----
  const store = {
    get(k, d) { try { const v = localStorage.getItem("tracy." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("tracy." + k, JSON.stringify(v)); } catch {} },
  };

  const settings = {
    backendUrl: store.get("backendUrl", cfgDefaults.backendUrl || "http://localhost:3000"),
    surface: store.get("surface", cfgDefaults.defaultSurface || "desktop"),
    userId: store.get("userId", null),
    autoSpeak: store.get("autoSpeak", true),
    autoSend: store.get("autoSend", true),
    voiceURI: store.get("voiceURI", null),
  };
  if (!settings.userId) {
    // Stable per-device id so per-user memory (backend) can key off it later.
    settings.userId = "web-" + Math.random().toString(36).slice(2, 10);
    store.set("userId", settings.userId);
  }

  // ---- State ----
  let messages = [];        // conversation history sent to the backend each turn
  let busy = false;

  // ---- Elements ----
  const elTranscript = $("transcript");
  const elInput = $("input");
  const elCaption = $("caption");
  const elOrb = $("orb");
  const elStatus = $("status-dot");
  const elSurface = $("surface");
  const elMic = $("mic-btn");

  // ---- Rendering ----
  function addMessage(role, text, opts = {}) {
    const div = document.createElement("div");
    div.className = "msg " + role;
    div.textContent = text;
    if (opts.tools && opts.tools.length) {
      const t = document.createElement("span");
      t.className = "tools";
      t.textContent = "used: " + opts.tools.join(", ");
      div.appendChild(t);
    }
    elTranscript.appendChild(div);
    elTranscript.scrollTop = elTranscript.scrollHeight;
    return div;
  }

  function setOrbState(state) {
    elOrb.classList.remove("speaking", "listening");
    if (state) elOrb.classList.add(state);
  }

  // ---- Backend call ----
  async function send(text) {
    if (busy || !text.trim()) return;
    busy = true;
    elInput.value = "";
    addMessage("user", text);
    messages.push({ role: "user", content: text });

    const thinking = addMessage("tracy thinking", "Tracy is thinking");
    thinking.classList.add("dots");

    try {
      const res = await fetch(settings.backendUrl.replace(/\/$/, "") + "/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ surface: settings.surface, userId: settings.userId, messages }),
      });
      thinking.remove();

      if (!res.ok) {
        let msg = `Tracy couldn't answer (HTTP ${res.status}).`;
        try { const j = await res.json(); if (j.error) msg = j.error; } catch {}
        addMessage("system", msg);
        return;
      }

      const data = await res.json();
      const reply = data.reply || "(no reply)";
      messages.push({ role: "assistant", content: reply });
      const bubble = addMessage("tracy", reply, { tools: data.toolsUsed });
      speak(reply, bubble);
    } catch (err) {
      thinking.remove();
      addMessage("system", `Couldn't reach Tracy at ${settings.backendUrl}. Is the backend up? (${err.message})`);
      setStatus(false);
    } finally {
      busy = false;
    }
  }

  // ---- Connection status ----
  async function setStatus(online) {
    elStatus.classList.toggle("online", online === true);
    elStatus.classList.toggle("offline", online === false);
  }
  async function pingHealth() {
    try {
      const res = await fetch(settings.backendUrl.replace(/\/$/, "") + "/health", { method: "GET" });
      setStatus(res.ok);
    } catch { setStatus(false); }
  }

  // ---- Text-to-speech (Tracy's voice) + live captions ----
  const synth = window.speechSynthesis;
  let voices = [];
  function loadVoices() {
    voices = synth ? synth.getVoices() : [];
    populateVoicePicker();
  }
  function pickVoice() {
    if (!voices.length) return null;
    if (settings.voiceURI) {
      const m = voices.find((v) => v.voiceURI === settings.voiceURI);
      if (m) return m;
    }
    // Prefer an English female-ish voice for Tracy; fall back to first en, then any.
    return (
      voices.find((v) => /en(-|_)?/i.test(v.lang) && /female|samantha|zira|google us english|aria|jenny/i.test(v.name)) ||
      voices.find((v) => /^en/i.test(v.lang)) ||
      voices[0]
    );
  }

  function speak(text, bubbleEl) {
    if (!settings.autoSpeak || !synth) return;
    synth.cancel();

    // Build word-highlightable caption.
    elCaption.innerHTML = "";
    const spans = [];
    const wordRegex = /\S+\s*/g;
    let m;
    while ((m = wordRegex.exec(text)) !== null) {
      const span = document.createElement("span");
      span.className = "w";
      span.textContent = m[0];
      span.dataset.start = m.index;
      span.dataset.end = m.index + m[0].length;
      elCaption.appendChild(span);
      spans.push(span);
    }

    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice();
    if (v) u.voice = v;
    u.rate = 1.02; u.pitch = 1.05;

    u.onstart = () => setOrbState("speaking");
    u.onend = () => { setOrbState(null); spans.forEach((s) => s.classList.remove("on")); };
    u.onerror = () => setOrbState(null);
    u.onboundary = (e) => {
      const i = e.charIndex;
      spans.forEach((s) => {
        const on = i >= +s.dataset.start && i < +s.dataset.end;
        s.classList.toggle("on", on);
      });
    };
    synth.speak(u);
  }

  function stopSpeaking() { if (synth) synth.cancel(); setOrbState(null); }

  // ---- Speech-to-text (mic) ----
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null, listening = false;
  if (SR) {
    recognition = new SR();
    recognition.lang = "en-US";
    recognition.interimResults = true;
    recognition.continuous = false;

    recognition.onstart = () => { listening = true; elMic.classList.add("listening"); setOrbState("listening"); };
    recognition.onend = () => { listening = false; elMic.classList.remove("listening"); if (!elOrb.classList.contains("speaking")) setOrbState(null); };
    recognition.onerror = () => { listening = false; elMic.classList.remove("listening"); setOrbState(null); };
    recognition.onresult = (e) => {
      let txt = "";
      for (let i = e.resultIndex; i < e.results.length; i++) txt += e.results[i][0].transcript;
      elInput.value = txt.trim();
      const final = e.results[e.results.length - 1].isFinal;
      if (final && settings.autoSend && elInput.value) send(elInput.value);
    };
  } else {
    elMic.disabled = true;
    elMic.title = "Voice input isn't supported in this browser (try Chrome/Edge, or Chrome on Android).";
  }

  function toggleMic() {
    if (!recognition) return;
    stopSpeaking();
    if (listening) { recognition.stop(); return; }
    try { recognition.start(); } catch {}
  }

  // ---- Settings modal ----
  const modal = $("settings");
  function openSettings() {
    $("cfg-backend").value = settings.backendUrl;
    $("cfg-user").value = settings.userId;
    $("cfg-autospeak").checked = settings.autoSpeak;
    $("cfg-autosend").checked = settings.autoSend;
    populateVoicePicker();
    modal.hidden = false;
  }
  function populateVoicePicker() {
    const sel = $("cfg-voice");
    if (!sel) return;
    sel.innerHTML = "";
    if (!voices.length) { const o = document.createElement("option"); o.textContent = "(default)"; sel.appendChild(o); return; }
    for (const v of voices) {
      const o = document.createElement("option");
      o.value = v.voiceURI; o.textContent = `${v.name} (${v.lang})`;
      if (v.voiceURI === settings.voiceURI) o.selected = true;
      sel.appendChild(o);
    }
  }
  function saveSettings() {
    settings.backendUrl = $("cfg-backend").value.trim() || settings.backendUrl;
    settings.userId = $("cfg-user").value.trim() || settings.userId;
    settings.autoSpeak = $("cfg-autospeak").checked;
    settings.autoSend = $("cfg-autosend").checked;
    const vsel = $("cfg-voice");
    settings.voiceURI = vsel && vsel.value ? vsel.value : settings.voiceURI;
    for (const k of ["backendUrl", "userId", "autoSpeak", "autoSend", "voiceURI"]) store.set(k, settings[k]);
    modal.hidden = true;
    pingHealth();
  }

  // ---- Wire up ----
  elSurface.value = settings.surface;
  elSurface.addEventListener("change", () => { settings.surface = elSurface.value; store.set("surface", settings.surface); });
  $("send-btn").addEventListener("click", () => send(elInput.value));
  elInput.addEventListener("keydown", (e) => { if (e.key === "Enter") send(elInput.value); });
  elMic.addEventListener("click", toggleMic);
  $("settings-btn").addEventListener("click", openSettings);
  $("cfg-save").addEventListener("click", saveSettings);
  $("cfg-clear").addEventListener("click", () => { messages = []; elTranscript.innerHTML = ""; elCaption.textContent = ""; modal.hidden = true; });
  $("mute-btn").addEventListener("click", (e) => {
    settings.autoSpeak = !settings.autoSpeak; store.set("autoSpeak", settings.autoSpeak);
    e.currentTarget.textContent = settings.autoSpeak ? "🔊" : "🔇";
    if (!settings.autoSpeak) stopSpeaking();
  });
  $("mute-btn").textContent = settings.autoSpeak ? "🔊" : "🔇";

  if (synth) { loadVoices(); synth.onvoiceschanged = loadVoices; }

  // Greeting
  addMessage("tracy", "Hi, I'm Tracy — Interverse's assistant. Tap the mic and talk to me, or type below.");
  pingHealth();

  // PWA service worker (installable, offline shell)
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
})();
