// Tracy frontend logic — chat + voice.
// Vanilla JS, no build step. Talks to Tracy's backend /chat endpoint, keeps
// conversation history client-side, does speech-to-text (mic, with a learning
// correction layer) and text-to-speech (Tracy speaks, with live captions).

(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const cfgDefaults = window.TRACY_CONFIG || {};
  const Corrections = window.TracyCorrections;
  // Native voice (Capacitor iOS/Android app). null in a normal browser → Web Speech.
  const Native = () => (window.TracyNative && window.TracyNative.isNative) ? window.TracyNative : null;

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
    silenceMs: store.get("silenceMs", 2500), // pause after you stop before sending
    apiKey: store.get("apiKey", ""),         // optional bring-your-own Anthropic key
  };
  if (!settings.userId) {
    settings.userId = "web-" + Math.random().toString(36).slice(2, 10);
    store.set("userId", settings.userId);
  }
  if (Corrections) Corrections.init(settings.userId);

  // ---- Auth (access-key gate) ----
  const api = () => settings.backendUrl.replace(/\/$/, "");
  const getToken = () => store.get("token", null);
  const setToken = (t) => store.set("token", t);
  const clearToken = () => { try { localStorage.removeItem("tracy.token"); } catch {} };

  function showGate(msg) {
    const g = $("gate"); if (!g) return;
    $("gate-error").textContent = msg || "";
    g.hidden = false;
    setTimeout(() => { const k = $("gate-key"); if (k) k.focus(); }, 60);
  }
  function hideGate() { const g = $("gate"); if (g) g.hidden = true; }

  async function submitKey() {
    const key = ($("gate-key").value || "").trim();
    if (!key) { $("gate-error").textContent = "Enter your access key."; return; }
    const btn = $("gate-enter"); btn.disabled = true;
    try {
      const res = await fetch(api() + "/auth", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.token) {
        setToken(data.token); $("gate-key").value = ""; $("gate-error").textContent = "";
        hideGate(); pingHealth();
      } else {
        $("gate-error").textContent = data.error || "That access key isn't valid.";
      }
    } catch { $("gate-error").textContent = `Couldn't reach the server at ${api()}.`; }
    finally { btn.disabled = false; }
  }

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

  // ---- Markdown (render for the eyes, strip for the voice) ----
  function escapeHtml(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function inlineMd(s) {
    // s is already HTML-escaped
    s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
    return s;
  }
  function renderMarkdown(text) {
    const lines = String(text).replace(/\r\n/g, "\n").split("\n");
    let html = "", listType = null, inCode = false, codeBuf = "";
    const closeList = () => { if (listType) { html += listType === "ul" ? "</ul>" : "</ol>"; listType = null; } };
    for (const line of lines) {
      if (/^\s*```/.test(line)) {
        if (inCode) { html += `<pre><code>${escapeHtml(codeBuf)}</code></pre>`; codeBuf = ""; inCode = false; }
        else { closeList(); inCode = true; }
        continue;
      }
      if (inCode) { codeBuf += (codeBuf ? "\n" : "") + line; continue; }
      const esc = escapeHtml(line);
      let m;
      if ((m = esc.match(/^\s{0,3}#{1,6}\s+(.*)$/))) { closeList(); html += `<div class="md-h">${inlineMd(m[1])}</div>`; continue; }
      if ((m = esc.match(/^\s*[-*+]\s+(.*)$/))) { if (listType !== "ul") { closeList(); html += "<ul>"; listType = "ul"; } html += `<li>${inlineMd(m[1])}</li>`; continue; }
      if ((m = esc.match(/^\s*\d+\.\s+(.*)$/))) { if (listType !== "ol") { closeList(); html += "<ol>"; listType = "ol"; } html += `<li>${inlineMd(m[1])}</li>`; continue; }
      // Markdown table separator row (|---|---|) — drop it, don't render pipes.
      if (/^[ \t]*\|?[ \t:|-]*--[ \t:|-]*$/.test(esc)) { closeList(); continue; }
      // Markdown table data row (| a | b |) — render as clean cells, no raw pipes.
      if ((m = esc.match(/^\s*\|(.+)\|\s*$/))) {
        closeList();
        const cells = m[1].split("|").map((c) => c.trim()).filter(Boolean).map((c) => `<span class="md-cell">${inlineMd(c)}</span>`);
        html += `<div class="md-row">${cells.join("")}</div>`;
        continue;
      }
      if (esc.trim() === "") { closeList(); html += "<br>"; continue; }
      closeList(); html += `<div>${inlineMd(esc)}</div>`;
    }
    if (inCode) html += `<pre><code>${escapeHtml(codeBuf)}</code></pre>`;
    closeList();
    return html;
  }
  // Plain prose for speech + captions — no symbols to read aloud.
  function stripMarkdown(text) {
    let s = String(text).replace(/\r\n/g, "\n");
    s = s.replace(/```([\s\S]*?)```/g, "$1");
    s = s.replace(/`([^`]+)`/g, "$1");
    s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
    s = s.replace(/__([^_]+)__/g, "$1");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2");
    s = s.replace(/(^|[^_])_([^_\n]+)_/g, "$1$2");
    s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
    // Tables & dashes — otherwise she reads "pipe" and "dash dash dash" aloud.
    s = s.replace(/^[ \t]*\|?[ \t:|-]*--[ \t:|-]*$/gm, "");        // separator rows |---|---|
    s = s.replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_, row) =>          // | a | b | c | -> "a, b, c"
      row.split("|").map((c) => c.trim()).filter(Boolean).join(", "));
    s = s.replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, "");  // horizontal rules --- ***
    s = s.replace(/\s[—–]\s/g, ", ");                             // " — " -> a spoken pause
    s = s.replace(/[—–]/g, " ");                                  // any leftover em/en dash
    s = s.replace(/^\s{0,3}#{1,6}\s+/gm, "");
    s = s.replace(/^\s*[-*+]\s+/gm, "");
    s = s.replace(/\n{3,}/g, "\n\n");
    s = s.replace(/[ \t]{2,}/g, " ");
    return s.trim();
  }

  // ---- Rendering ----
  function addMessage(role, text, opts = {}) {
    const div = document.createElement("div");
    div.className = "msg " + role;
    if (opts.markdown) div.innerHTML = renderMarkdown(text);
    else div.textContent = text;
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
    let willSpeak = false;
    elInput.value = "";
    addMessage("user", text);
    messages.push({ role: "user", content: text });

    const thinking = addMessage("tracy thinking", "Tracy is thinking");
    thinking.classList.add("dots");

    try {
      const headers = { "Content-Type": "application/json" };
      const tok = getToken();
      if (tok) headers.Authorization = "Bearer " + tok;
      if (settings.apiKey) headers["X-Anthropic-Key"] = settings.apiKey; // bill your own account
      const res = await fetch(api() + "/chat", {
        method: "POST",
        headers,
        body: JSON.stringify({ surface: settings.surface, userId: settings.userId, messages }),
      });
      thinking.remove();

      if (res.status === 401) { clearToken(); showGate("Please enter your access key to continue."); return; }
      if (!res.ok) {
        let msg = `Tracy couldn't answer (HTTP ${res.status}).`;
        try { const j = await res.json(); if (j.error) msg = j.error; } catch {}
        addMessage("system", msg);
        return;
      }
      const data = await res.json();
      const reply = data.reply || "(no reply)";
      messages.push({ role: "assistant", content: reply });
      const bubble = addMessage("tracy", reply, { tools: data.toolsUsed, markdown: true });
      willSpeak = settings.autoSpeak && !!synth && !!reply;
      speak(reply, bubble); // no-op if autoSpeak is off
    } catch (err) {
      thinking.remove();
      addMessage("system", `Couldn't reach Tracy at ${settings.backendUrl}. Is the backend up? (${err.message})`);
      setStatus(false);
    } finally {
      busy = false;
      // Reopen the mic (hands-free) once it's the user's turn again. If Tracy is
      // speaking, her TTS onend handles the reopen instead (avoids echo).
      if (!willSpeak) maybeListen();
    }
  }

  // ---- Connection status ----
  function setStatus(online) {
    elStatus.classList.toggle("online", online === true);
    elStatus.classList.toggle("offline", online === false);
  }
  async function pingHealth() {
    try {
      const h = await fetch(api() + "/health").then((r) => r.json());
      setStatus(!!h.ok);
      if (h.authRequired && !getToken()) showGate();
    } catch { setStatus(false); }
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

  // iOS Safari blocks speechSynthesis unless it's first triggered inside a user
  // gesture. Tracy speaks AFTER a network reply (not a gesture), so we "unlock"
  // TTS by speaking a silent utterance on the first tap/keypress.
  let ttsPrimed = false;
  function primeTTS() {
    if (ttsPrimed || !synth) return;
    ttsPrimed = true;
    // Canonical iOS unlock: speak an empty utterance inside the user gesture.
    try { synth.speak(new SpeechSynthesisUtterance("")); } catch {}
  }

  // Split text into short caption "cues" (like CC lines): break on clause/sentence
  // punctuation and cap length, so only a few words show at a time.
  function buildCues(text) {
    const words = [];
    const re = /\S+\s*/g; let m;
    while ((m = re.exec(text)) !== null) words.push({ text: m[0], start: m.index, end: m.index + m[0].length });
    const cues = []; let cur = [];
    const flush = () => { if (cur.length) { cues.push({ start: cur[0].start, end: cur[cur.length - 1].end, words: cur }); cur = []; } };
    for (const w of words) {
      cur.push(w);
      const endsClause = /[.,;:!?]["')\]]?\s*$/.test(w.text);
      if (cur.length >= 7 || (endsClause && cur.length >= 3)) flush();
    }
    flush();
    return cues;
  }

  function speak(text, bubbleEl) {
    if (!settings.autoSpeak) return;
    const nat = Native();
    if (!synth && !nat) return;
    if (synth) { synth.cancel(); try { synth.resume(); } catch {} } // iOS can leave the queue paused

    text = stripMarkdown(text); // don't read "**", "`", "#", etc. aloud
    const cues = buildCues(text);
    let curCue = -1, gotBoundary = false, timers = [];
    const clearTimers = () => { timers.forEach(clearTimeout); timers = []; };
    const hideCaption = () => { elCaption.classList.remove("show"); };

    // Render one cue; optionally highlight the word at charIdx (boundary mode).
    const showCue = (ci, charIdx) => {
      const cue = cues[ci]; if (!cue) return;
      elCaption.innerHTML = "";
      for (const w of cue.words) {
        const s = document.createElement("span");
        s.className = "w"; s.textContent = w.text;
        if (charIdx == null || (charIdx >= w.start && charIdx < w.end)) s.classList.add("on");
        elCaption.appendChild(s);
      }
      elCaption.classList.add("show");
    };

    // Fallback for voices that don't emit boundary events: advance cues on a timer.
    const timerWalk = () => {
      clearTimers();
      const msPerWord = 340 / (settings.rate || 1);
      let acc = 0;
      cues.forEach((cue, ci) => { timers.push(setTimeout(() => { curCue = ci; showCue(ci, null); }, acc)); acc += cue.words.length * msPerWord; });
      timers.push(setTimeout(hideCaption, acc + 250));
    };

    // Native TTS (iOS/Android app): reliable voice. No word-boundary events, so
    // captions roll on the timer.
    if (nat) {
      speaking = true; setOrbState("speaking"); if (handsFree) stopRecognition();
      timerWalk();
      nat.tts.speak(text, { rate: settings.rate, pitch: settings.pitch }).then(() => {
        speaking = false; setOrbState(null); clearTimers(); hideCaption(); if (handsFree) restartSoon();
      });
      return;
    }

    let started = false;
    const makeUtterance = (withVoice) => {
      const u = new SpeechSynthesisUtterance(text);
      // iOS bug: setting utterance.voice can make speech silently not play. The
      // first try uses the chosen voice; the watchdog retry drops it (system default).
      if (withVoice) { const v = pickVoice(); if (v) u.voice = v; }
      u.rate = settings.rate; u.pitch = settings.pitch;
      u.onstart = () => {
        started = true; speaking = true; setOrbState("speaking"); if (handsFree) stopRecognition();
        if (cues.length) showCue(0, cues[0].start); curCue = 0;
        timers.push(setTimeout(() => { if (!gotBoundary) timerWalk(); }, 500)); // boundary fallback
      };
      u.onend = () => { speaking = false; setOrbState(null); clearTimers(); hideCaption(); if (handsFree) restartSoon(); };
      u.onerror = () => { speaking = false; setOrbState(null); clearTimers(); hideCaption(); if (handsFree) restartSoon(); };
      u.onboundary = (e) => {
        if (!gotBoundary) { gotBoundary = true; clearTimers(); }
        const i = e.charIndex;
        let ci = cues.findIndex((c) => i >= c.start && i < c.end);
        if (ci === -1) ci = curCue;
        if (ci === -1) return;
        if (ci !== curCue) { curCue = ci; showCue(ci, i); }
        else {
          const spans = elCaption.children, cue = cues[ci];
          for (let k = 0; k < spans.length && k < cue.words.length; k++) {
            const w = cue.words[k];
            spans[k].classList.toggle("on", i >= w.start && i < w.end);
          }
        }
      };
      return u;
    };

    synth.speak(makeUtterance(true));
    // iOS watchdog: if it never started, nudge the queue and retry without a
    // forced voice (the most common cause of silent speechSynthesis on Safari).
    setTimeout(() => {
      if (!started && !synth.speaking && settings.autoSpeak) {
        try { synth.resume(); } catch {}
        try { synth.speak(makeUtterance(false)); } catch {}
      }
    }, 400);
  }
  function stopSpeaking() { if (synth) synth.cancel(); const nat = Native(); if (nat) nat.tts.stop(); speaking = false; setOrbState(null); }

  // ---- Speech-to-text (mic) with hands-free + correction ----
  // We decide when you're done: the utterance is sent after `silenceMs` of no
  // speech. Mobile browsers end the recognition session between phrases (they
  // don't hold `continuous` like desktop), so we accumulate text ACROSS sessions
  // and keep the send timer running through `onend` — the pause, not the engine
  // ending, decides when to send.
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null, listening = false, restartTimer = null, sendTimer = null;
  let committed = "";   // finalized text from prior (ended) sessions this utterance
  let sessionText = ""; // current session's text (final + interim)

  function pendingText() { return (committed + " " + sessionText).replace(/\s+/g, " ").trim(); }
  function clearSend() { clearTimeout(sendTimer); sendTimer = null; }
  function armSend() { clearTimeout(sendTimer); sendTimer = setTimeout(endpoint, Math.round(settings.silenceMs)); }
  function resetBuffers() { committed = ""; sessionText = ""; }

  // Fires after a real pause: finalize + send (or leave for manual send).
  function endpoint() {
    clearSend();
    const raw = pendingText();
    const corrected = Corrections ? Corrections.apply(raw) : raw;
    const wasHandsFree = handsFree;
    resetBuffers();
    stopRecognition();
    if (!raw) return;
    lastSttRaw = raw; lastSttCorrected = corrected;
    if (wasHandsFree || settings.autoSend) send(corrected);
    else elInput.value = corrected; // leave in the box to review and send manually
  }

  if (SR) {
    recognition = new SR();
    recognition.lang = "en-US";
    recognition.interimResults = true;
    recognition.continuous = true; // desktop holds the stream; mobile ends per phrase

    recognition.onstart = () => { listening = true; elMic.classList.add("listening"); if (!speaking) setOrbState("listening"); };
    recognition.onend = () => {
      listening = false; elMic.classList.remove("listening");
      if (sessionText) { committed = pendingText(); sessionText = ""; } // commit this phrase
      if (!speaking) setOrbState(null);
      // Do NOT clear sendTimer — the pause window decides. Keep listening in
      // hands-free, or (one-shot) while an utterance is still awaiting its pause.
      restartSoon();
    };
    recognition.onerror = (e) => {
      listening = false; elMic.classList.remove("listening");
      if (!speaking) setOrbState(null);
      if (e.error === "not-allowed" || e.error === "service-not-allowed") { clearSend(); resetBuffers(); setHandsFree(false); }
      // "no-speech" / "aborted" are normal; onend handles the restart.
    };
    recognition.onresult = (e) => {
      let finalTxt = "", interim = "";
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalTxt += r[0].transcript; else interim += r[0].transcript;
      }
      sessionText = (finalTxt + " " + interim).trim();
      const raw = pendingText();
      const corrected = Corrections ? Corrections.apply(raw) : raw;
      elInput.value = corrected;
      lastSttRaw = raw; lastSttCorrected = corrected;
      if (raw) armSend(); // any speech (even interim) restarts the pause countdown
    };
  } else {
    // Don't hard-disable (a disabled button gives no tap feedback and looks
    // broken) — keep it tappable and explain on tap. iOS Safari commonly lacks
    // SpeechRecognition entirely.
    elMic.title = elHF.title = "Voice input isn't available in this browser.";
  }

  let warnedNoVoice = false;
  function noVoiceMsg() {
    if (warnedNoVoice) return;
    warnedNoVoice = true;
    addMessage("system", "Voice input isn't available in this browser — Safari on iPhone doesn't support it reliably. You can type here, and Tracy will still talk. (A native app version fixes this.)");
  }

  // Native STT feeds the SAME accumulation pipeline (sessionText → armSend).
  function onNativeTranscript(text) {
    sessionText = (text || "").trim();
    const raw = pendingText();
    const corrected = Corrections ? Corrections.apply(raw) : raw;
    elInput.value = corrected;
    lastSttRaw = raw; lastSttCorrected = corrected;
    if (raw) armSend();
  }
  function onNativeEnd() {
    listening = false; elMic.classList.remove("listening");
    if (sessionText) { committed = pendingText(); sessionText = ""; } // commit this phrase
    if (!speaking) setOrbState(null);
    restartSoon();
  }

  let starting = false;
  async function startRecognition() {
    if (listening || starting || speaking || busy) return;
    const nat = Native();
    if (nat && nat.stt) {
      starting = true;
      try {
        if (!(await nat.stt.available())) { noVoiceMsg(); return; }
        if (!(await nat.stt.requestPermission())) return;
        listening = true; elMic.classList.add("listening"); if (!speaking) setOrbState("listening");
        nat.stt.start(onNativeTranscript, onNativeEnd);
      } catch { listening = false; }
      finally { starting = false; }
      return;
    }
    if (!recognition) return;
    try { recognition.start(); } catch {}
  }
  function stopRecognition() {
    const nat = Native();
    if (nat && nat.stt && listening) { nat.stt.stop(); listening = false; elMic.classList.remove("listening"); return; }
    if (recognition && listening) { try { recognition.stop(); } catch {} }
  }
  function restartSoon() { clearTimeout(restartTimer); restartTimer = setTimeout(maybeListen, 300); }
  // Reopen the mic when appropriate: hands-free, or a one-shot utterance still
  // mid-pause (sendTimer pending). Never while speaking/busy/already listening.
  function maybeListen() { if (speaking || busy || listening) return; if (handsFree || sendTimer) startRecognition(); }

  function toggleMic() {
    primeTTS(); // unlock TTS on this tap even if voice input is unavailable
    if (!recognition && !Native()) { noVoiceMsg(); return; }
    stopSpeaking();
    if (listening) { clearSend(); resetBuffers(); stopRecognition(); }
    else { resetBuffers(); startRecognition(); }
  }
  function setHandsFree(on) {
    primeTTS();
    if (on && !recognition && !Native()) { noVoiceMsg(); return; } // can't go hands-free without voice input
    handsFree = on; settings.handsFree = on; store.set("handsFree", on);
    elHF.classList.toggle("active", on);
    const cb = $("cfg-handsfree"); if (cb) cb.checked = on;
    if (on) { stopSpeaking(); resetBuffers(); startRecognition(); }
    else { clearTimeout(restartTimer); clearSend(); resetBuffers(); stopRecognition(); }
  }

  // ---- Settings modal ----
  const modal = $("settings");
  function openSettings() {
    $("cfg-backend").value = settings.backendUrl;
    $("cfg-user").value = settings.userId;
    $("cfg-apikey").value = settings.apiKey || "";
    $("cfg-autospeak").checked = settings.autoSpeak;
    $("cfg-autosend").checked = settings.autoSend;
    $("cfg-handsfree").checked = handsFree;
    $("cfg-rate").value = settings.rate; $("cfg-rate-val").textContent = (+settings.rate).toFixed(2);
    $("cfg-pitch").value = settings.pitch; $("cfg-pitch-val").textContent = (+settings.pitch).toFixed(2);
    $("cfg-silence").value = settings.silenceMs / 1000; $("cfg-silence-val").textContent = (settings.silenceMs / 1000).toFixed(1) + "s";
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
    settings.apiKey = $("cfg-apikey").value.trim();
    settings.autoSpeak = $("cfg-autospeak").checked;
    settings.autoSend = $("cfg-autosend").checked;
    settings.rate = +$("cfg-rate").value; settings.pitch = +$("cfg-pitch").value;
    settings.silenceMs = Math.round((+$("cfg-silence").value) * 1000);
    const vsel = $("cfg-voice"); settings.voiceURI = vsel && vsel.value ? vsel.value : settings.voiceURI;
    for (const k of ["backendUrl", "userId", "apiKey", "autoSpeak", "autoSend", "voiceURI", "rate", "pitch", "silenceMs"]) store.set(k, settings[k]);
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
  $("cfg-silence").addEventListener("input", (e) => { $("cfg-silence-val").textContent = (+e.target.value).toFixed(1) + "s"; });
  $("cfg-clear").addEventListener("click", () => { messages = []; elTranscript.innerHTML = ""; elCaption.textContent = ""; modal.hidden = true; });
  $("mute-btn").addEventListener("click", (e) => {
    settings.autoSpeak = !settings.autoSpeak; store.set("autoSpeak", settings.autoSpeak);
    e.currentTarget.textContent = settings.autoSpeak ? "🔊" : "🔇";
    if (!settings.autoSpeak) stopSpeaking();
  });
  $("mute-btn").textContent = settings.autoSpeak ? "🔊" : "🔇";

  $("gate-enter").addEventListener("click", submitKey);
  $("gate-key").addEventListener("keydown", (e) => { if (e.key === "Enter") submitKey(); });

  // Prime iOS text-to-speech on the first interaction anywhere on the page.
  ["pointerdown", "keydown", "touchend"].forEach((ev) =>
    document.addEventListener(ev, primeTTS, { capture: true, once: true }));

  // Explicit press feedback (iOS Safari doesn't reliably paint :active on tap).
  [elMic, elHF, $("send-btn")].forEach((el) => {
    if (!el) return;
    const on = () => el.classList.add("pressing");
    const off = () => el.classList.remove("pressing");
    el.addEventListener("pointerdown", on);
    ["pointerup", "pointercancel", "pointerleave"].forEach((e) => el.addEventListener(e, off));
  });

  if (synth) { loadVoices(); synth.onvoiceschanged = loadVoices; }
  if (handsFree) elHF.classList.add("active"); // restored on next user gesture (mic needs a gesture to start)

  addMessage("tracy", "Hi, I'm Tracy — Interverse's assistant. Tap the mic and talk to me, or type below.");
  pingHealth();

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
})();
