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
  const browserTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { return ""; } };
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
        body: JSON.stringify({ surface: settings.surface, userId: settings.userId, messages, tz: browserTz() }),
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
  let committed = "";       // FINALIZED text from prior (ended) sessions this utterance
  let sessionFinal = "";    // finalized text in the CURRENT session
  let sessionInterim = "";  // unstable in-progress text (shown live, NEVER committed)

  // Mobile recognizers often emit interim text that RESTATES already-finalized
  // words, and sometimes re-finalize overlapping audio across sessions — which
  // shows up as "how's how's how's baby baby resale". Collapse repeated adjacent
  // words and repeated adjacent phrases so what's shown/sent reads sensibly.
  function dedupeSpeech(text) {
    let words = String(text).trim().split(/\s+/).filter(Boolean);
    if (words.length < 2) return words.join(" ");
    const norm = (w) => w.toLowerCase().replace(/[.,!?;:]+$/, "");
    const eq = (a, b) => norm(a) === norm(b);
    // 1) drop a word that immediately repeats the one before it
    const out = [];
    for (const w of words) { if (out.length && eq(out[out.length - 1], w)) continue; out.push(w); }
    words = out;
    // 2) collapse an immediately-repeated phrase (longest first): A B A B -> A B
    let changed = true;
    while (changed) {
      changed = false;
      const maxN = Math.min(6, Math.floor(words.length / 2));
      for (let n = maxN; n >= 2 && !changed; n--) {
        for (let i = 0; i + 2 * n <= words.length; i++) {
          let match = true;
          for (let j = 0; j < n; j++) { if (!eq(words[i + j], words[i + n + j])) { match = false; break; } }
          if (match) { words.splice(i + n, n); changed = true; break; }
        }
      }
    }
    return words.join(" ");
  }

  function pendingText() {
    return dedupeSpeech((committed + " " + sessionFinal + " " + sessionInterim).replace(/\s+/g, " ").trim());
  }
  // Commit only what the engine finalized — interim words are dropped, so a
  // session ending mid-phrase can't fold the same partial in twice. Dedupe on
  // commit too, so cross-session re-finalized overlaps don't accumulate.
  function commitSession() {
    if (sessionFinal) committed = dedupeSpeech((committed + " " + sessionFinal).replace(/\s+/g, " ").trim());
    sessionFinal = ""; sessionInterim = "";
  }
  function clearSend() { clearTimeout(sendTimer); sendTimer = null; }
  function armSend() { clearTimeout(sendTimer); sendTimer = setTimeout(endpoint, Math.round(settings.silenceMs)); }
  function resetBuffers() { committed = ""; sessionFinal = ""; sessionInterim = ""; }

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
      commitSession(); // fold only finalized text forward; drop interim
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
      // e.results holds the whole current session (continuous). Rebuild final vs
      // interim from scratch each event — finals accumulate, interim is replaced.
      const finals = [], interims = [];
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        (r.isFinal ? finals : interims).push(r[0].transcript.trim());
      }
      sessionFinal = finals.join(" ").replace(/\s+/g, " ").trim();
      sessionInterim = interims.join(" ").replace(/\s+/g, " ").trim();
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
    // Native plugins return the session's best transcript so far (stable). Treat
    // it as the session's final text (replace, don't append) — never as interim.
    sessionFinal = (text || "").replace(/\s+/g, " ").trim();
    sessionInterim = "";
    const raw = pendingText();
    const corrected = Corrections ? Corrections.apply(raw) : raw;
    elInput.value = corrected;
    lastSttRaw = raw; lastSttCorrected = corrected;
    if (raw) armSend();
  }
  function onNativeEnd() {
    listening = false; elMic.classList.remove("listening");
    commitSession(); // fold only finalized text forward
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
    loadNotifySettings();
    updateInstallRow();
    updatePushRow();
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

  // ---- Notifications (daily check-in) ----
  function authHeaders(json) {
    const h = json ? { "Content-Type": "application/json" } : {};
    const tok = getToken(); if (tok) h.Authorization = "Bearer " + tok;
    return h;
  }
  function notifyStatus(msg, ok) {
    const el = $("cfg-notify-status"); if (!el) return;
    el.textContent = msg || ""; el.style.color = ok === false ? "#ff9a9a" : "";
  }
  async function loadNotifySettings() {
    const box = $("cfg-apps"); if (box) box.innerHTML = "";
    notifyStatus("");
    try {
      const res = await fetch(api() + "/subscription?userId=" + encodeURIComponent(settings.userId), { headers: authHeaders(false) });
      if (!res.ok) return;
      const data = await res.json();
      const sub = data.subscription || { email: "", apps: [], digest: false };
      $("cfg-notify-email").value = sub.email || "";
      $("cfg-digest").checked = !!sub.digest;
      (data.apps || []).forEach((a) => {
        const wrap = document.createElement("label"); wrap.className = "row";
        const span = document.createElement("span"); span.textContent = a.label;
        const cb = document.createElement("input"); cb.type = "checkbox"; cb.value = a.key;
        cb.checked = (sub.apps || []).includes(a.key);
        wrap.appendChild(span); wrap.appendChild(cb); box.appendChild(wrap);
      });
      if (data.emailReady === false) notifyStatus("Email isn't set up on the server yet — check-ins won't send until it is.", false);
    } catch { /* ignore */ }
  }
  function selectedApps() {
    return [...document.querySelectorAll("#cfg-apps input[type=checkbox]")].filter((c) => c.checked).map((c) => c.value);
  }
  async function saveNotify() {
    notifyStatus("Saving…");
    try {
      const body = { userId: settings.userId, email: $("cfg-notify-email").value.trim(), apps: selectedApps(), digest: $("cfg-digest").checked, tz: browserTz() };
      const res = await fetch(api() + "/subscription", { method: "POST", headers: authHeaders(true), body: JSON.stringify(body) });
      notifyStatus(res.ok ? "Saved." : "Couldn't save.", res.ok);
      return res.ok;
    } catch { notifyStatus("Couldn't reach the server.", false); return false; }
  }
  async function testNotify() {
    notifyStatus("Sending test…");
    if (!(await saveNotify())) return;
    try {
      const res = await fetch(api() + "/subscription/test", { method: "POST", headers: authHeaders(true), body: JSON.stringify({ userId: settings.userId }) });
      const data = await res.json().catch(() => ({}));
      notifyStatus(res.ok ? `Test sent to ${data.to || "your email"} — check your inbox (and spam).` : (data.error || "Couldn't send."), res.ok);
    } catch { notifyStatus("Couldn't reach the server.", false); }
  }

  // ---- Install (backup entry point in Settings) ----
  function updateInstallRow() {
    const btn = $("cfg-install-btn"), hint = $("cfg-install-hint");
    if (!btn || !hint) return;
    const TI = window.TracyInstall;
    if (TI && TI.isStandalone && TI.isStandalone()) { btn.hidden = true; hint.textContent = "Installed — you're using the app. ✓"; return; }
    if (TI && TI.canPrompt && TI.canPrompt()) { btn.hidden = false; hint.textContent = "Add Tracy to your home screen for a full-screen app."; return; }
    if (TI && TI.isIOS) { btn.hidden = true; hint.textContent = TI.iosHint(); return; }
    btn.hidden = true;
    hint.textContent = "To install, use your browser menu → “Install app” / “Add to Home screen.”";
  }

  // ---- Push notifications on this device ----
  function urlB64ToUint8(base64) {
    const pad = "=".repeat((4 - (base64.length % 4)) % 4);
    const b64 = (base64 + pad).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(b64); const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }
  function pushStatus(msg, ok) { const el = $("cfg-push-status"); if (el) { el.textContent = msg || ""; el.style.color = ok === false ? "#ff9a9a" : ""; } }
  const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  async function currentPushSub() { try { const reg = await navigator.serviceWorker.ready; return await reg.pushManager.getSubscription(); } catch { return null; } }
  async function updatePushRow() {
    const cb = $("cfg-push"); if (!cb) return;
    if (!pushSupported()) {
      cb.checked = false; cb.disabled = true;
      const TI = window.TracyInstall;
      pushStatus(TI && TI.isIOS && !(TI.isStandalone && TI.isStandalone())
        ? "On iPhone, install Tracy to your home screen first (above), then enable this."
        : "This browser doesn't support push notifications.");
      return;
    }
    cb.disabled = false;
    const sub = await currentPushSub();
    cb.checked = !!sub;
    pushStatus(sub ? "On for this device." : "");
  }
  async function enablePush() {
    const cb = $("cfg-push");
    pushStatus("Enabling…");
    if (!pushSupported()) { pushStatus("Not supported on this browser.", false); if (cb) cb.checked = false; return; }
    let cfg;
    try { cfg = await fetch(api() + "/push/config").then((r) => r.json()); }
    catch { pushStatus("Couldn't reach the server.", false); if (cb) cb.checked = false; return; }
    if (!cfg.configured || !cfg.publicKey) { pushStatus("Push isn't set up on the server yet.", false); if (cb) cb.checked = false; return; }
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { pushStatus("Notifications permission was denied — allow it in your browser settings.", false); if (cb) cb.checked = false; return; }
    try {
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(cfg.publicKey) });
      const res = await fetch(api() + "/push/subscribe", { method: "POST", headers: authHeaders(true), body: JSON.stringify({ userId: settings.userId, subscription: sub }) });
      pushStatus(res.ok ? "On for this device — your check-ins will arrive here." : "Couldn't save this device.", res.ok);
      if (cb) cb.checked = res.ok;
    } catch (e) { pushStatus("Couldn't enable: " + e.message, false); if (cb) cb.checked = false; }
  }
  async function disablePush() {
    pushStatus("Turning off…");
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch(api() + "/push/unsubscribe", { method: "POST", headers: authHeaders(true), body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {});
        await sub.unsubscribe();
      }
      pushStatus("Off for this device.");
    } catch (e) { pushStatus("Couldn't turn off: " + e.message, false); }
  }

  // ---- Wire up ----
  elSurface.value = settings.surface;
  // If a previously-saved surface was removed from the picker (e.g. BabyResell,
  // Car Parts), fall back to Desktop instead of showing a blank selection.
  if (elSurface.selectedIndex < 0) { settings.surface = "desktop"; elSurface.value = "desktop"; store.set("surface", "desktop"); }
  elSurface.addEventListener("change", () => { settings.surface = elSurface.value; store.set("surface", settings.surface); });
  $("send-btn").addEventListener("click", () => send(elInput.value));
  elInput.addEventListener("keydown", (e) => { if (e.key === "Enter") send(elInput.value); });
  elInput.addEventListener("input", () => { if (!elInput.value) { lastSttRaw = null; lastSttCorrected = null; } });
  elMic.addEventListener("click", toggleMic);
  elHF.addEventListener("click", () => setHandsFree(!handsFree));
  $("settings-btn").addEventListener("click", openSettings);
  $("cfg-save").addEventListener("click", saveSettings);
  $("cfg-notify-save").addEventListener("click", saveNotify);
  $("cfg-notify-test").addEventListener("click", testNotify);
  $("cfg-install-btn").addEventListener("click", async () => { if (window.TracyInstall) { await window.TracyInstall.prompt(); updateInstallRow(); } });
  $("cfg-push").addEventListener("change", (e) => { if (e.target.checked) enablePush(); else disablePush(); });
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
