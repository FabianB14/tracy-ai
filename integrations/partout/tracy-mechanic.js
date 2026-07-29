/* PartOut ⇄ Tracy — AI Mechanic, routed through Tracy's Car Repair brain.
 *
 * Drop-in replacement for PartOut's local `mechanicChat(history)`. Instead of
 * calling Gemini directly from the browser, this sends the conversation to
 * Tracy's `/chat` endpoint on the `carparts` surface. That means every repair
 * question flows through Tracy's SHARED repair memory + safety guardrails:
 *
 *   1. Tracy checks what she already knows for that year/make/model/part.
 *   2. If she has it, she answers from memory (fast, consistent, free of a
 *      model call). If not, she works it out with Claude/Gemini and SAVES the
 *      answer back — so the next person asking about that repair gets it from
 *      memory. She gets better at car repair the more PartOut is used.
 *   3. Safety guardrails (jack stands, HV/EV, fuel, airbags, brakes…) are baked
 *      into the `carparts` surface prompt, so they apply to every answer.
 *
 * Same signature and return type as the original `mechanicChat` — it takes the
 * chat history and returns the reply text — so nothing else in PartOut changes.
 *
 * Two ways to use it (see integrations/partout/README.md):
 *   A) Replace the body of `mechanicChat` in docs/app.js with a call to
 *      `TracyMechanic.chat(history)`.
 *   B) Load this file as a <script> before app.js and delete PartOut's local
 *      `mechanicChat`; this one becomes the global.
 *
 * It reuses two helpers PartOut already defines: `getVehicle()` and
 * `dataUrlToBase64()`. If you load it standalone it falls back to its own.
 */
(function (global) {
  'use strict';

  // Where Tracy lives. Override per-deploy by setting localStorage 'tracy_base'
  // (e.g. a staging backend) — defaults to the production Render backend.
  const DEFAULT_BASE = 'https://tracy-ai.onrender.com';
  const base = () => (localStorage.getItem('tracy_base') || DEFAULT_BASE).replace(/\/+$/, '');

  // A stable per-device id so Tracy can key logs/personalization. Not secret;
  // shared repair knowledge is global, so this is only for attribution.
  function userId() {
    let id = localStorage.getItem('tracy_user') || localStorage.getItem('po_user');
    if (!id) {
      id = 'partout-' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem('tracy_user', id);
    }
    return id;
  }

  // IANA timezone (best-effort) so any check-ins/timestamps land in local time.
  function tz() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; }
  }

  // ---- Optional access key ----------------------------------------------
  // If Tracy's backend has AUTH_SECRET set (the access gate), calls to /chat
  // need a bearer token. Store the access key in localStorage 'tracy_key' and
  // this redeems it once for a token (cached). If the gate is OFF, this is a
  // no-op and no key is needed.
  let tokenCache = localStorage.getItem('tracy_token') || null;
  async function authHeader() {
    const key = (localStorage.getItem('tracy_key') || '').trim();
    if (!key) return {};                       // gate off, or no key configured
    if (tokenCache) return { Authorization: 'Bearer ' + tokenCache };
    try {
      const r = await fetch(base() + '/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.token) {
        tokenCache = d.token;
        localStorage.setItem('tracy_token', d.token);
        return { Authorization: 'Bearer ' + tokenCache };
      }
    } catch { /* fall through — try unauthenticated */ }
    return {};
  }

  // ---- Helpers PartOut already has (fallbacks if loaded standalone) ------
  const getVehicle = global.getVehicle || (() => localStorage.getItem('po_vehicle') || '');
  const toB64 = global.dataUrlToBase64 || ((u) => u.slice(u.indexOf(',') + 1));

  // The user's own Gemini key (PartOut's 🔑 button stores it as 'po_api_key').
  // Passed through to Tracy so the mechanic's generation bills the user's key —
  // NOT Tracy's account. Tracy uses it Gemini-first and only falls back to her
  // own Claude when Gemini can't. Blank = Tracy uses her shared key.
  const geminiKey = () => (localStorage.getItem('po_api_key') || '').trim();

  // Turn PartOut's chat history ({role:'user'|'model', text, img}) into Tracy
  // `/chat` messages. User turns may carry a photo as an image content block;
  // assistant turns are sent as plain text (any generated diagram image is
  // dropped — Tracy only needs the words for context).
  function toMessages(history, vehicle) {
    const recent = (history || []).slice(-16);
    const msgs = recent.map((m) => {
      const role = m.role === 'user' ? 'user' : 'assistant';
      if (role === 'user' && m.img) {
        const blocks = [];
        if (m.text) blocks.push({ type: 'text', text: m.text });
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: toB64(m.img) },
        });
        return { role, content: blocks };
      }
      // An assistant turn can be a generated diagram with no text at all —
      // Anthropic's API rejects empty assistant content, so describe it instead.
      if (role === 'assistant' && !m.text) {
        return { role, content: '(shared a diagram image)' };
      }
      return { role, content: m.text || '' };
    });

    // Anchor to the vehicle: fold "Vehicle: …" into the latest USER turn so
    // Tracy ties her answer (and what she saves to memory) to the exact
    // year/make/model. Improves both the answer and future memory hits.
    if (vehicle) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role !== 'user') continue;
        const note = `Vehicle: ${vehicle}. `;
        if (typeof msgs[i].content === 'string') {
          msgs[i].content = note + msgs[i].content;
        } else if (Array.isArray(msgs[i].content)) {
          const t = msgs[i].content.find((b) => b.type === 'text');
          if (t) t.text = note + t.text;
          else msgs[i].content.unshift({ type: 'text', text: note.trim() });
        }
        break;
      }
    }
    return msgs;
  }

  function friendlyError(status) {
    if (status === 401 || status === 403) return 'Tracy needs an access key for this backend. Add it in settings, or ask your admin.';
    if (status === 429) return 'Tracy is busy right now. Give it a few seconds and try again.';
    if (status >= 500) return 'Tracy hit a snag on the server. Try again in a moment.';
    return `Tracy couldn’t answer that (HTTP ${status}). Try again.`;
  }

  // The main entry point. history: PartOut's state.chat array. Returns the
  // reply text (a string), same as the original mechanicChat.
  async function chat(history) {
    const messages = toMessages(history, getVehicle());
    const gk = geminiKey();
    let res;
    try {
      res = await fetch(base() + '/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(gk ? { 'X-Gemini-Key': gk } : {}),
          ...(await authHeader()),
        },
        body: JSON.stringify({ surface: 'carparts', userId: userId(), tz: tz(), messages }),
      });
    } catch {
      throw new Error('Network error — check your internet connection and try again.');
    }
    if (res.status === 401 || res.status === 403) {
      tokenCache = null;
      localStorage.removeItem('tracy_token');       // token may have expired/been revoked
    }
    if (!res.ok) throw new Error(friendlyError(res.status));
    const data = await res.json().catch(() => ({}));
    const reply = (data && typeof data.reply === 'string') ? data.reply.trim() : '';
    if (!reply) throw new Error('Tracy came back empty. Try rephrasing that.');
    return reply;
  }

  global.TracyMechanic = { chat, toMessages, userId, base };

  // Convenience: if PartOut has no local mechanicChat (option B), expose one.
  if (typeof global.mechanicChat !== 'function') {
    global.mechanicChat = chat;
  }
})(typeof window !== 'undefined' ? window : this);
