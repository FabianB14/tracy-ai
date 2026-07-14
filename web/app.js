// Tracy frontend logic — chat + voice.
// Vanilla JS, no build step. Talks to Tracy's backend /chat endpoint, keeps
// conversation history client-side, does speech-to-text (mic, with a learning
// correction layer) and text-to-speech (Tracy speaks, with live captions).

(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const cfgDefaults = window.TRACY_CONFIG || {};
  const Corrections = window.TracyCorrections;

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
    handsFree: store.get("handsFree", false),
    voiceURI: store.get("voiceURI", null),
    rate: store.get("rate", 1.0),
    pitch: store.get("pitch", 1.0),
  };
  if (!settings.userId) {
    settings.userId = "web-" + Math.random().toString(36).slice(2, 10);
    store.set("userId", settings.userId);
  }
  if (Corrections) Corrections.init(settings.userId);

  // ---- State ----
  let messages = [];
  let busy = false;
  let speaking = false;
  let handsFree = settings.handsFree;
  let lastSttRaw = null;        // raw transcript STT produced (for learn-from-edit)
  let lastSttCorrected = null;  // what we put in the box after correction

  // ---- Elements ----
  const elTranscript = $("transcript");
  const elInput = $("input");
  const elCaption = $("caption");
  const elOrb = $("orb");
  const elStatus = $("status-dot");
  const elSurface = $("surface");
  const elMic = $("mic-btn");
  const elHF = $("handsfree-btn");

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
    text = (text || "").trim();
    if (busy || !text) return;

    // Learn from an edit: STT filled the box, user changed it, then sent.
    if (Corrections && lastSttRaw && text !== lastSttCorrected) {
      Corrections.learnFromEdit(lastSttRaw, text);
    }
    lastSttRaw = null; lastSttCorrected = null;

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
  function setStatus(online) {
    elStatus.classList.toggle("online", online === true);
    elStatus.classList.toggle("offline", online === false);
  }
  async function pingHealth() {
    try { setStatus((await fetch(settings.backendUrl.replace(/\/$/, "") + "/health")).ok); }
    catch { setStatus(false); }
  }

  // ---- Text-to-speech (Tracy's voice) ----
  const synth = window.speechSynthesis;
  let voices = [];
  function loadVoices() { voices = synth ? synth.getVoices() : []; populateVoicePicker(); }

  // Score voices by naturalness so we default to the best one available.
  function voiceScore(v) {
    const n = (v.name || "").toLowerCase(), lang = (v.lang || "").toLowerCase();
    let s = 0;
    if (/^en[-_]us/.test(lang)) s += 5; else if (/^en/.test(lang)) s += 3;
    if (/natural|neural|online/.test(n)) s += 6;
    if (/google/.test(n)) s += 4;
    if (/siri|samantha|aria|jenny|libby|sonia|ava|allison|nova|serena/.test(n)) s += 4;
    if (/female|woman/.test(n)) s += 1;
    if (/espeak|robo|compact/.test(n)) s -= 4; // older/robotic engines
    if (/david|mark|george/.test(n)) s -= 1;
    return s;
  }
  function pickVoice() {
    if (settings.voiceURI) { const m = voices.find((v) => v.voiceURI === settings.voiceURI); if (m) return m; }
    if (!voices.length) return null;
    return [...voices].sort((a, b) => voiceScore(b) - voiceScore(a))[0];
  }

  function speak(text, bubbleEl) {
    if (!settings.autoSpeak || !synth) return;
    synth.cancel();

    // Word-highlightable caption.
    elCaption.innerHTML = "";
    const spans = [];
    const re = /\S+\s*/g; let m;
    while ((m = re.exec(text)) !== null) {
      const span = document.createElement("span");
      span.className = "w"; span.textContent = m[0];
      span.dataset.start = m.index; span.dataset.end = m.index + m[0].length;
      elCaption.appendChild(span); spans.push(span);
    }

    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice(); if (v) u.voice = v;
    u.rate = settings.rate; u.pitch = settings.pitch;

    u.onstart = () => { speaking = true; setOrbState("speaking"); if (handsFree) stopRecognition(); };
    u.onend = () => { speaking = false; setOrbState(null); spans.forEach((s) => s.classList.remove("on")); if (handsFree) restartSoon(); };
    u.onerror = () => { speaking = false; setOrbState(null); if (handsFree) restartSoon(); };
    u.onboundary = (e) => {
      const i = e.charIndex;
      spans.forEach((s) => s.classList.toggle("on", i >= +s.dataset.start && i < +s.dataset.end));
    };
    synth.speak(u);
  }
  function stopSpeaking() { if (synth) synth.cancel(); speaking = false; setOrbState(null); }

  // ---- Speech-to-text (mic) with hands-free + correction ----
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null, listening = false, restartTimer = null;

  if (SR) {
    recognition = new SR();
    recognition.lang = "en-US";
    recognition.interimResults = true;
    recognition.continuous = false;

    recognition.onstart = () => { listening = true; elMic.classList.add("listening"); if (!speaking) setOrbState("listening"); };
    recognition.onend = () => {
      listening = false; elMic.classList.remove("listening");
      if (!speaking) setOrbState(null);
      if (handsFree && !speaking) restartSoon(); // open-mic: keep listening
    };
    recognition.onerror = (e) => {
      listening = false; elMic.classList.remove("listening");
      if (!speaking) setOrbState(null);
      // "not-allowed" = mic permission denied → stop trying.
      if (e.error === "not-allowed" || e.error === "service-not-allowed") setHandsFree(false);
    };
    recognition.onresult = (e) => {
      let raw = "";
      for (let i = e.resultIndex; i < e.results.length; i++) raw += e.results[i][0].transcript;
      raw = raw.trim();
      const corrected = Corrections ? Corrections.apply(raw) : raw;
      elInput.value = corrected;
      const isFinal = e.results[e.results.length - 1].isFinal;
      if (isFinal) {
        lastSttRaw = raw; lastSttCorrected = corrected;
        if ((handsFree || settings.autoSend) && corrected) send(corrected);
      }
    };
  } else {
    elMic.disabled = true; elHF.disabled = true;
    elMic.title = elHF.title = "Voice input isn't supported in this browser (try Chrome/Edge, or Chrome on Android).";
  }

  function startRecognition() { if (!recognition || listening || speaking) return; try { recognition.start(); } catch {} }
  function stopRecognition() { if (recognition && listening) { try { recognition.stop(); } catch {} } }
  function restartSoon() { clearTimeout(restartTimer); restartTimer = setTimeout(() => { if (handsFree && !speaking && !listening) startRecognition(); }, 350); }

  function toggleMic() {
    if (!recognition) return;
    stopSpeaking();
    if (listening) recognition.stop(); else startRecognition();
  }
  function setHandsFree(on) {
    handsFree = on; settings.handsFree = on; store.set("handsFree", on);
    elHF.classList.toggle("active", on);
    const cb = $("cfg-handsfree"); if (cb) cb.checked = on;
    if (on) { stopSpeaking(); startRecognition(); }
    else { clearTimeout(restartTimer); stopRecognition(); }
  }

  // ---- Settings modal ----
  const modal = $("settings");
  function openSettings() {
    $("cfg-backend").value = settings.backendUrl;
    $("cfg-user").value = settings.userId;
    $("cfg-autospeak").checked = settings.autoSpeak;
    $("cfg-autosend").checked = settings.autoSend;
    $("cfg-handsfree").checked = handsFree;
    $("cfg-rate").value = settings.rate; $("cfg-rate-val").textContent = (+settings.rate).toFixed(2);
    $("cfg-pitch").value = settings.pitch; $("cfg-pitch-val").textContent = (+settings.pitch).toFixed(2);
    if (Corrections) $("cfg-corrections").value = formatCorrections(Corrections.list());
    populateVoicePicker();
    modal.hidden = false;
  }
  function populateVoicePicker() {
    const sel = $("cfg-voice"); if (!sel) return;
    sel.innerHTML = "";
    if (!voices.length) { const o = document.createElement("option"); o.textContent = "(default)"; sel.appendChild(o); return; }
    const ranked = [...voices].sort((a, b) => voiceScore(b) - voiceScore(a));
    ranked.forEach((v, i) => {
      const o = document.createElement("option");
      o.value = v.voiceURI; o.textContent = `${i === 0 ? "★ " : ""}${v.name} (${v.lang})`;
      if (v.voiceURI === settings.voiceURI) o.selected = true;
      sel.appendChild(o);
    });
  }
  function formatCorrections(map) { return Object.entries(map).map(([h, v]) => `${h} = ${v}`).join("\n"); }
  function parseCorrections(txt) {
    const obj = {};
    for (const line of (txt || "").split(/\n/)) {
      const i = line.indexOf("=");
      if (i < 1) continue;
      const h = line.slice(0, i).trim().toLowerCase();
      const v = line.slice(i + 1).trim();
      if (h && v) obj[h] = v;
    }
    return obj;
  }
  function saveSettings() {
    settings.backendUrl = $("cfg-backend").value.trim() || settings.backendUrl;
    settings.userId = $("cfg-user").value.trim() || settings.userId;
    settings.autoSpeak = $("cfg-autospeak").checked;
    settings.autoSend = $("cfg-autosend").checked;
    settings.rate = +$("cfg-rate").value; settings.pitch = +$("cfg-pitch").value;
    const vsel = $("cfg-voice"); settings.voiceURI = vsel && vsel.value ? vsel.value : settings.voiceURI;
    for (const k of ["backendUrl", "userId", "autoSpeak", "autoSend", "voiceURI", "rate", "pitch"]) store.set(k, settings[k]);
    if (Corrections) { Corrections.init(settings.userId); Corrections.replaceAll(parseCorrections($("cfg-corrections").value)); }
    setHandsFree($("cfg-handsfree").checked);
    modal.hidden = true;
    pingHealth();
  }

  // ---- Wire up ----
  elSurface.value = settings.surface;
  elSurface.addEventListener("change", () => { settings.surface = elSurface.value; store.set("surface", settings.surface); });
  $("send-btn").addEventListener("click", () => send(elInput.value));
  elInput.addEventListener("keydown", (e) => { if (e.key === "Enter") send(elInput.value); });
  elInput.addEventListener("input", () => { if (!elInput.value) { lastSttRaw = null; lastSttCorrected = null; } });
  elMic.addEventListener("click", toggleMic);
  elHF.addEventListener("click", () => setHandsFree(!handsFree));
  $("settings-btn").addEventListener("click", openSettings);
  $("cfg-save").addEventListener("click", saveSettings);
  $("cfg-rate").addEventListener("input", (e) => { $("cfg-rate-val").textContent = (+e.target.value).toFixed(2); });
  $("cfg-pitch").addEventListener("input", (e) => { $("cfg-pitch-val").textContent = (+e.target.value).toFixed(2); });
  $("cfg-clear").addEventListener("click", () => { messages = []; elTranscript.innerHTML = ""; elCaption.textContent = ""; modal.hidden = true; });
  $("mute-btn").addEventListener("click", (e) => {
    settings.autoSpeak = !settings.autoSpeak; store.set("autoSpeak", settings.autoSpeak);
    e.currentTarget.textContent = settings.autoSpeak ? "🔊" : "🔇";
    if (!settings.autoSpeak) stopSpeaking();
  });
  $("mute-btn").textContent = settings.autoSpeak ? "🔊" : "🔇";

  if (synth) { loadVoices(); synth.onvoiceschanged = loadVoices; }
  if (handsFree) elHF.classList.add("active"); // restored on next user gesture (mic needs a gesture to start)

  addMessage("tracy", "Hi, I'm Tracy — Interverse's assistant. Tap the mic and talk to me, or type below.");
  pingHealth();

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
})();
