// Tracy speech-correction layer.
//
// Speech-to-text mis-hears words — especially brand/product names. This module
// cleans up the transcript before it's shown/sent, and LEARNS over time:
//   - a seeded domain glossary + common mishearings (works out of the box)
//   - fuzzy-corrects tokens that are very close to a known term
//   - learns from your edits (if you fix the transcribed text before sending)
//   - lets you teach it directly (Settings → Voice corrections)
//
// Learned corrections are stored per-user in localStorage, so Tracy remembers
// how you talk across sessions on this device.

window.TracyCorrections = (function () {
  "use strict";

  let userId = "anon";
  let learned = {}; // { heardLowercase: "Meant" }

  const key = () => "tracy.corrections." + userId;

  // Canonical terms in Tracy's world. Single words get fuzzy-matched; phrases
  // are matched via the seed map below.
  const GLOSSARY = [
    "BabyResell", "Interverse", "UPPAbaby", "Chicco", "KeyFit", "Graco", "Britax",
    "Nuna", "Doona", "Bugaboo", "Maxi-Cosi", "bassinet", "stroller", "swaddle",
    "onesie", "Fisher-Price", "fitment",
  ];

  // Common mishearings → intended. Merged UNDER the user's learned map (user wins).
  const SEED = {
    "up a baby": "UPPAbaby", "uppa baby": "UPPAbaby", "upa baby": "UPPAbaby",
    "chico": "Chicco", "cheeko": "Chicco", "cheeco": "Chicco",
    "key fit": "KeyFit", "keyfit": "KeyFit",
    "baby resell": "BabyResell", "baby recell": "BabyResell", "baby re-sell": "BabyResell",
    "inner verse": "Interverse", "interverse": "Interverse",
    "gracko": "Graco", "maxi cozy": "Maxi-Cosi", "maxi cosy": "Maxi-Cosi",
    "car seats": "car seats", "car parts": "car parts",
  };

  function load() {
    try { learned = JSON.parse(localStorage.getItem(key()) || "{}"); }
    catch { learned = {}; }
  }
  function save() {
    try { localStorage.setItem(key(), JSON.stringify(learned)); } catch {}
  }
  function init(uid) { userId = uid || "anon"; load(); }

  // Effective map: seed overlaid by learned.
  function map() { return Object.assign({}, SEED, learned); }

  // Levenshtein distance (small strings).
  function lev(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 0; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++)
      for (let j = 1; j <= n; j++)
        d[i][j] = Math.min(
          d[i - 1][j] + 1, d[i][j - 1] + 1,
          d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
        );
    return d[m][n];
  }

  function preserveTail(orig, replacement) {
    // Keep trailing punctuation/space the token carried.
    const tail = orig.match(/[^\w'-]+$/);
    return replacement + (tail ? tail[0] : "");
  }

  // Fuzzy-correct a single word token against single-word glossary terms.
  function fuzzyToken(token) {
    const core = token.replace(/[^\w'-]+$/, "");
    const lower = core.toLowerCase();
    if (!lower || lower.length < 5) return token;
    let best = null, bestD = Infinity;
    for (const g of GLOSSARY) {
      if (g.includes(" ") || g.includes("-")) continue;
      const d = lev(lower, g.toLowerCase());
      if (d < bestD) { bestD = d; best = g; }
    }
    // Conservative: only replace on a near-miss of a proper noun.
    if (best && bestD >= 1 && bestD <= 1 && best.toLowerCase() !== lower) {
      return preserveTail(token, best);
    }
    return token;
  }

  // Apply corrections to a full transcript.
  function apply(text) {
    if (!text) return text;
    let out = text;
    // Phrase-level replacements first (multi-word keys).
    for (const [heard, meant] of Object.entries(map())) {
      if (!heard.includes(" ")) continue;
      out = out.replace(new RegExp("\\b" + heard.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "gi"), meant);
    }
    // Token pass: exact learned/seed word replacements, then fuzzy glossary.
    const m = map();
    out = out.replace(/\S+/g, (tok) => {
      const core = tok.replace(/[^\w'-]+$/, "").toLowerCase();
      if (m[core]) return preserveTail(tok, m[core]);
      return fuzzyToken(tok);
    });
    return out;
  }

  function closeEnough(a, b) {
    a = a.toLowerCase(); b = b.toLowerCase();
    if (a === b) return false;
    const d = lev(a, b);
    return d > 0 && d <= Math.max(1, Math.floor(Math.max(a.length, b.length) * 0.34));
  }

  // Explicitly teach a correction.
  function learn(heard, meant) {
    heard = (heard || "").trim().toLowerCase();
    meant = (meant || "").trim();
    if (!heard || !meant || heard === meant.toLowerCase()) return;
    learned[heard] = meant;
    save();
  }

  // Learn from a user edit: what STT heard vs what the user actually sent.
  function learnFromEdit(heard, meant) {
    if (!heard || !meant) return;
    const h = heard.trim().split(/\s+/);
    const m = meant.trim().split(/\s+/);
    if (h.length === m.length) {
      // Same length → learn the individual words that changed (and are close).
      for (let i = 0; i < h.length; i++) {
        const hw = h[i].replace(/[^\w'-]+/g, ""), mw = m[i].replace(/[^\w'-]+/g, "");
        if (hw && mw && hw.toLowerCase() !== mw.toLowerCase() && closeEnough(hw, mw)) {
          learn(hw.toLowerCase(), mw);
        }
      }
    } else if (h.length <= 4 && m.length <= 4 && closeEnough(heard, meant)) {
      // Short phrase reworded → learn the whole phrase.
      learn(heard.toLowerCase(), meant.trim());
    }
  }

  return {
    init, apply, learn, learnFromEdit,
    list: () => Object.assign({}, learned),
    remove: (h) => { delete learned[(h || "").toLowerCase()]; save(); },
    replaceAll: (obj) => { learned = obj || {}; save(); },
    seedList: () => Object.assign({}, SEED),
  };
})();
