// Tracy's tools — the actions she can take on behalf of users.
//
// Tools are grouped into named TOOL SETS, one per capability area. Surfaces opt
// into the tool sets they need (see src/surfaces.js). A small CORE set (memory)
// is always available, because remembering people is part of who Tracy is on
// every surface. Nothing else assumes a specific client — a surface with no
// tool sets still gets a Tracy who talks and can remember.
//
// Tool handlers receive (input, context), where context = { userId, surface }.
//
// The BabyResell handlers below are STUBS: replace the TODO sections with real
// calls to the BabyResell API. (Per project plan: that wiring comes later.)

import { addMemory } from "./memory.js";
import { babyresellConfigured, getStats, getActivity, getReportStats, getOpenReports, getShippingBacklog } from "./babyresell.js";
import { geminiConfigured, webResearch, analyzeMedia } from "./gemini.js";
import { getSubscription, setSubscription } from "./subscriptions.js";
import { knownApps } from "./digest.js";

// ---------------------------------------------------------------------------
// Core tool set — available on every surface
// ---------------------------------------------------------------------------

const coreSchemas = [
  {
    name: "remember",
    description:
      "Save a durable fact or preference about the CURRENT user so you can " +
      "recall it in future conversations — e.g. their name, how they like to " +
      "be helped, what they're selling or shopping for, ongoing context. Use " +
      "it for things worth remembering long-term, not one-off details. The " +
      "user's saved notes are provided to you at the start of each conversation.",
    input_schema: {
      type: "object",
      properties: {
        fact: {
          type: "string",
          description: "A concise fact or preference to remember about this user.",
        },
      },
      required: ["fact"],
    },
  },
];

const coreHandlers = {
  async remember({ fact }, context = {}) {
    if (!context.userId) {
      return { status: "not_saved", reason: "No userId on this request, so there's nothing to key memory to." };
    }
    const ok = await addMemory(context.userId, fact);
    return ok ? { status: "remembered", fact } : { status: "not_saved", reason: "storage error" };
  },
};

// ---------------------------------------------------------------------------
// Notifications — let the user manage daily check-ins conversationally
// ---------------------------------------------------------------------------
// Available on every surface (folded into core below). Tracy can set up, list,
// and cancel a user's daily email digest straight from chat.

const pad = (n) => String(n).padStart(2, "0");
function parseTime(str) {
  const s = String(str).trim().toLowerCase();
  let m;
  if ((m = s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/))) {
    let h = +m[1]; const min = +m[2];
    if (m[3] === "pm" && h < 12) h += 12; if (m[3] === "am" && h === 12) h = 0;
    return h > 23 || min > 59 ? null : `${pad(h)}:${pad(min)}`;
  }
  if ((m = s.match(/^(\d{1,2})\s*(am|pm)$/))) {
    let h = +m[1]; if (m[2] === "pm" && h < 12) h += 12; if (m[2] === "am" && h === 12) h = 0;
    return h > 23 ? null : `${pad(h)}:00`;
  }
  if ((m = s.match(/^(\d{1,2})$/))) { const h = +m[1]; return h > 23 ? null : `${pad(h)}:00`; }
  if ((m = s.match(/^(\d{1,2})(\d{2})$/))) { const h = +m[1], min = +m[2]; return h > 23 || min > 59 ? null : `${pad(h)}:${pad(min)}`; }
  if (s === "noon") return "12:00"; if (s === "midnight") return "00:00";
  if (s === "morning") return "08:00"; if (s === "evening") return "18:00";
  return null;
}
function prettyTime(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  const ap = h < 12 ? "am" : "pm"; let hh = h % 12; if (hh === 0) hh = 12;
  return m ? `${hh}:${pad(m)} ${ap}` : `${hh} ${ap}`;
}
const normApp = (x) => String(x).toLowerCase().replace(/[^a-z]/g, "");
function resolveApps(list) {
  const known = knownApps(); const apps = [], unknown = [];
  for (const item of list || []) {
    const n = normApp(item);
    const hit = known.find((a) => normApp(a.key) === n || normApp(a.label) === n || n.includes(normApp(a.key)) || normApp(a.key).includes(n));
    if (hit) { if (!apps.includes(hit.key)) apps.push(hit.key); } else unknown.push(item);
  }
  return { apps, unknown };
}
const appLabel = (key) => (knownApps().find((a) => a.key === key) || { label: key }).label;

const notifySchemas = [
  {
    name: "schedule_checkin",
    description:
      "Set up or update a recurring daily EMAIL check-in for the current user about one or more " +
      "Interverse apps. Use whenever they ask you to email/notify/send them a summary or updates on a " +
      "schedule (e.g. 'email me BabyResell numbers every morning at 8'). After it saves, tell them " +
      "plainly what you set (which app, what time) and that they can change or cancel it anytime.",
    input_schema: {
      type: "object",
      properties: {
        apps: { type: "array", items: { type: "string" }, description: "Apps to include, e.g. ['babyresell']. Omit to keep their current set (or all apps if none yet)." },
        time: { type: "string", description: "Local time of day to send, e.g. '8am', '08:00', '6:30pm'. Omit to keep current." },
        email: { type: "string", description: "Where to send it. Omit if one is already on file." },
        timezone: { type: "string", description: "IANA timezone like 'America/New_York'. Omit to use the user's detected timezone." },
      },
    },
  },
  {
    name: "list_checkins",
    description: "Show the current user's daily check-in settings (apps, time, email). Use when they ask what they're subscribed to or what's set up.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "cancel_checkin",
    description: "Turn off the current user's daily check-in. Use when they ask to stop, remove, cancel, or unsubscribe from the daily email.",
    input_schema: { type: "object", properties: {} },
  },
];

const notifyHandlers = {
  async schedule_checkin({ apps, time, email, timezone } = {}, context = {}) {
    if (!context.userId) return { error: "There's no user id on this session, so I can't save a schedule." };
    const existing = (await getSubscription(context.userId)) || { email: "", apps: [], time: "08:00", tz: null };

    let useApps;
    if (Array.isArray(apps) && apps.length) {
      const r = resolveApps(apps);
      if (!r.apps.length) return { status: "needs_info", reason: `I don't cover those. I can send: ${knownApps().map((a) => a.label).join(", ")}.` };
      useApps = r.apps;
    } else {
      useApps = existing.apps && existing.apps.length ? existing.apps : knownApps().map((a) => a.key);
    }

    let useTime = existing.time || "08:00";
    if (time) { const t = parseTime(time); if (!t) return { status: "needs_info", reason: `I couldn't read the time "${time}". Try something like "8am" or "18:30".` }; useTime = t; }

    const useEmail = (email && String(email).trim()) || existing.email || "";
    const useTz = timezone || existing.tz || context.tz || undefined;

    const ok = await setSubscription(context.userId, { email: useEmail, apps: useApps, digest: true, time: useTime, tz: useTz });
    if (!ok) return { error: "I couldn't save that just now." };
    return {
      status: useEmail ? "scheduled" : "saved_need_email",
      apps: useApps.map(appLabel),
      time: prettyTime(useTime),
      timezone: useTz || "the user's timezone",
      email: useEmail || null,
      note: useEmail ? undefined : "Saved — but I still need an email address to actually send it. Ask the user for their email.",
    };
  },
  async list_checkins(_input, context = {}) {
    if (!context.userId) return { error: "There's no user id on this session." };
    const s = await getSubscription(context.userId);
    if (!s || !s.digest) return { status: "none", message: "No daily check-in is set up for this user." };
    return { status: "active", apps: (s.apps || []).map(appLabel), time: prettyTime(s.time), timezone: s.tz, email: s.email || null };
  },
  async cancel_checkin(_input, context = {}) {
    if (!context.userId) return { error: "There's no user id on this session." };
    const s = await getSubscription(context.userId);
    if (!s || !s.digest) return { status: "none", message: "There's no daily check-in to cancel." };
    const ok = await setSubscription(context.userId, { ...s, digest: false });
    return ok ? { status: "cancelled" } : { error: "I couldn't cancel it just now." };
  },
};

// Fold notification tools into the always-on core set.
coreSchemas.push(...notifySchemas);
Object.assign(coreHandlers, notifyHandlers);

// ---------------------------------------------------------------------------
// BabyResell tool set
// ---------------------------------------------------------------------------

const babyresellSchemas = [
  {
    name: "search_listings",
    description:
      "Search BabyResell listings by keyword, category, and price range. " +
      "Use whenever a user is looking for an item.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search keywords, e.g. 'jogging stroller'" },
        category: {
          type: "string",
          description: "Optional category filter",
          enum: ["strollers", "car_seats", "furniture", "clothing", "toys", "feeding", "other"],
        },
        max_price: { type: "number", description: "Optional max price in USD" },
      },
      required: ["query"],
    },
  },
  {
    name: "suggest_price",
    description:
      "Suggest a fair resale price range for a baby item based on brand, " +
      "model, age, and condition. Use when a seller asks what to charge.",
    input_schema: {
      type: "object",
      properties: {
        item_description: { type: "string", description: "Brand, model, and item type" },
        condition: {
          type: "string",
          enum: ["like_new", "good", "fair", "well_loved"],
        },
        age_months: { type: "number", description: "How old the item is, in months" },
      },
      required: ["item_description", "condition"],
    },
  },
  {
    name: "draft_listing",
    description:
      "Create a draft listing (title, description, suggested price, category) " +
      "from a seller's rough description. Returns the draft for user approval — " +
      "does NOT publish.",
    input_schema: {
      type: "object",
      properties: {
        raw_description: { type: "string", description: "The seller's own words about the item" },
        condition: { type: "string", enum: ["like_new", "good", "fair", "well_loved"] },
      },
      required: ["raw_description"],
    },
  },
];

async function searchListings({ query, category, max_price }) {
  // TODO: replace with a real call to the BabyResell API, e.g.
  // const res = await fetch(`${process.env.BABYRESELL_API}/listings?q=${...}`);
  return {
    note: "STUB DATA — wire this to the real BabyResell API",
    results: [
      { id: "demo-1", title: `Demo result for "${query}"`, price: 45, condition: "good" },
    ],
    filters: { category: category ?? null, max_price: max_price ?? null },
  };
}

async function suggestPrice({ item_description, condition, age_months }) {
  // TODO: real version = query sold-listing comps from the DB.
  // Until then, Claude's own knowledge does a decent job — return the inputs
  // and let the model reason, or plug in a comps lookup here.
  return {
    note: "STUB — no comps database connected yet. Model should estimate from general knowledge and say the range is approximate.",
    item_description,
    condition,
    age_months: age_months ?? null,
  };
}

async function draftListing({ raw_description, condition }) {
  // The model itself writes the listing; this tool just records the draft so
  // the app can show it in a review screen. TODO: persist to DB.
  return {
    status: "draft_ready",
    raw_description,
    condition: condition ?? "unspecified",
    next_step: "Present the drafted title/description to the user for approval before publishing.",
  };
}

const babyresellHandlers = {
  search_listings: searchListings,
  suggest_price: suggestPrice,
  draft_listing: draftListing,
};

// ---------------------------------------------------------------------------
// BabyResell admin tool set (business/marketplace stats) — ADMIN ONLY
// ---------------------------------------------------------------------------
// Exposes BabyResell's business numbers, so this must never be on a customer
// surface. It's gated to an allowlist of admin userIds (ADMIN_USER_IDS env);
// if that's unset, the tools refuse — default-deny for sensitive data.

// Parse the ADMIN_USER_IDS allowlist forgivingly. Users set this by hand in a
// hosting dashboard, so accept any sane separator — commas, spaces, or line
// breaks — and strip stray quotes/brackets. This prevents the classic footgun
// where "id1 id2" (space instead of comma) or a pasted newline silently matches
// nobody. Exported so /diag reports the exact same parsing the gate uses.
export function getAdminIds() {
  return (process.env.ADMIN_USER_IDS || "")
    .split(/[\s,]+/)
    .map((s) => s.replace(/^["'\[\]]+|["'\[\]]+$/g, "").trim())
    .filter(Boolean);
}

function isAdminUser(context) {
  const allow = getAdminIds();
  return allow.length > 0 && context && allow.includes(context.userId);
}

const babyresellAdminSchemas = [
  {
    name: "get_babyresell_stats",
    description:
      "Get BabyResell's current business/marketplace stats: total users, total " +
      "and active listings, total transactions, platform revenue (the sum of " +
      "platform fees Interverse has earned), and 30-day growth (new users, " +
      "listings, transactions). Use whenever the user asks how BabyResell is " +
      "doing, its numbers, revenue, or growth.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_babyresell_activity",
    description:
      "Get BabyResell's most recent activity: newest users, newest listings, " +
      "and newest transactions. Use for 'what's happened lately / recently' questions.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "How many recent items per category (default 10)." },
      },
    },
  },
  {
    name: "get_babyresell_moderation",
    description:
      "Get BabyResell's moderation queue: counts of pending/reviewing/open/total " +
      "item reports, plus the list of open (pending) reports. Use when asked what " +
      "needs review/moderation, or about reported items/users.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_babyresell_shipping",
    description:
      "Get BabyResell's shipping backlog: how many paid orders still need a " +
      "shipping label, and how many had label errors. Use when asked about " +
      "shipping status/backlog or orders waiting to ship.",
    input_schema: { type: "object", properties: {} },
  },
];

async function callBabyresell(fn, context) {
  if (!isAdminUser(context)) {
    return { error: "Business stats are admin-only. Set ADMIN_USER_IDS to your userId to enable this." };
  }
  if (!babyresellConfigured()) {
    return { note: "BabyResell API isn't connected yet. Set BABYRESELL_API_URL and admin credentials (see .env.example)." };
  }
  try {
    return await fn();
  } catch (err) {
    if (err.message === "auth-failed") return { error: "BabyResell rejected the admin credentials (token expired, wrong secret, or not an admin)." };
    if (err.message === "not-configured") return { note: "BabyResell API isn't fully configured." };
    return { error: `Couldn't reach BabyResell: ${err.message}.` };
  }
}

// Trim a populated report to the essentials (drop image blobs etc.).
function trimReport(r) {
  return {
    id: r._id || r.id,
    status: r.status,
    reason: r.reason || r.category || r.type,
    details: r.description || r.details,
    createdAt: r.createdAt,
    reporter: r.reporter && r.reporter.username,
    reportedUser: r.reportedUser && r.reportedUser.username,
    item: r.item && { title: r.item.title, price: r.item.price, status: r.item.status },
  };
}

const babyresellAdminHandlers = {
  get_babyresell_stats: (_input, context) => callBabyresell(() => getStats().then((stats) => ({ source: "babyresell", stats })), context),
  get_babyresell_activity: ({ limit } = {}, context) =>
    callBabyresell(() => getActivity(limit || 10).then((activity) => ({ source: "babyresell", activity })), context),
  get_babyresell_moderation: (_input, context) =>
    callBabyresell(async () => {
      const [stats, reports] = await Promise.all([getReportStats(), getOpenReports()]);
      const list = Array.isArray(reports) ? reports.slice(0, 20).map(trimReport) : [];
      return { source: "babyresell", moderation: stats, openReports: list };
    }, context),
  get_babyresell_shipping: (_input, context) =>
    callBabyresell(() => getShippingBacklog().then((backlog) => ({ source: "babyresell", shipping: backlog })), context),
};

// ---------------------------------------------------------------------------
// Tool-set registry
// ---------------------------------------------------------------------------
// Add a new capability area by adding an entry here, then reference it from a
// surface in src/surfaces.js. Future: `carparts` (fitment lookup), etc.

export const toolSets = {
  babyresell: { schemas: babyresellSchemas, handlers: babyresellHandlers },
  babyresell_admin: { schemas: babyresellAdminSchemas, handlers: babyresellAdminHandlers },
};

// ---------------------------------------------------------------------------
// Web search & media — provider split (Claude orchestrates, Gemini as a tool)
// ---------------------------------------------------------------------------
// Two ways Tracy looks things up, chosen by which providers are configured:
//   • Anthropic web_search — server-side tool; the API runs the search inline.
//   • Gemini web_research  — handler tool backed by Gemini + Google Search
//     grounding, for current events / live info. When a Gemini key is present
//     Tracy uses this INSTEAD of Anthropic search (never both — two search
//     tools confuse the model). Plus analyze_media (YouTube/audio/video).
//
// Env:
//   TRACY_WEB_SEARCH=off          disable web search entirely
//   TRACY_WEB_SEARCH_MAX_USES=5   cap Anthropic searches per reply (cost)
//   TRACY_SEARCH_PROVIDER=auto    auto | gemini | anthropic
//                                 (auto = Gemini if GEMINI_API_KEY set, else Anthropic)

const geminiSchemas = [
  {
    name: "web_research",
    description:
      "Search the live web for current or recent information — today's prices, " +
      "recent events, news, availability, real-time facts. Returns an answer " +
      "grounded in web results plus its sources. Use whenever freshness matters " +
      "and you can't be sure from memory; don't use it for things you already know.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look up, phrased as a search or question." },
      },
      required: ["query"],
    },
  },
  {
    name: "analyze_media",
    description:
      "Watch/listen to a media URL and answer a question about it. Best for " +
      "YouTube links (also other public video/audio URLs). Use when the user " +
      "shares a video/audio link and wants it summarized or asked about.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The media URL (e.g. a YouTube link)." },
        question: { type: "string", description: "What the user wants to know about it. Optional." },
      },
      required: ["url"],
    },
  },
];

const geminiHandlers = {
  web_research: ({ query }) => webResearch(query),
  analyze_media: ({ url, question }) => analyzeMedia(url, question),
};

// Which engine backs "search the web": off, "gemini", or "anthropic".
function searchProvider() {
  const on = (process.env.TRACY_WEB_SEARCH || "on").toLowerCase() !== "off";
  if (!on) return "off";
  const pref = (process.env.TRACY_SEARCH_PROVIDER || "auto").toLowerCase();
  if (pref === "anthropic") return "anthropic";
  if (pref === "gemini") return geminiConfigured() ? "gemini" : "anthropic";
  return geminiConfigured() ? "gemini" : "anthropic"; // auto
}

// Build a toolkit for a surface: the always-on core set (memory + search/media)
// plus the named surface tool sets. `context` ({ userId, surface }) is passed to
// every handler. Unknown tool-set names are ignored (a surface can reference sets
// not built yet).
export function buildToolkit(toolSetNames = [], context = {}) {
  const schemas = [...coreSchemas];
  const handlers = { ...coreHandlers };

  // Web search: Gemini (handler) when selected, else Anthropic (server tool).
  const provider = searchProvider();
  if (provider === "gemini") {
    schemas.push(geminiSchemas[0]); // web_research
    handlers.web_research = geminiHandlers.web_research;
  } else if (provider === "anthropic") {
    const maxUses = Number(process.env.TRACY_WEB_SEARCH_MAX_USES || 5) || 5;
    schemas.push({ type: "web_search_20260209", name: "web_search", max_uses: maxUses });
  }

  // Media analysis (YouTube/audio/video) is Gemini-only; offer it whenever a
  // Gemini key is configured, independent of the web-search provider choice.
  if (geminiConfigured()) {
    schemas.push(geminiSchemas[1]); // analyze_media
    handlers.analyze_media = geminiHandlers.analyze_media;
  }

  for (const name of toolSetNames) {
    const set = toolSets[name];
    if (!set) continue;
    schemas.push(...set.schemas);
    Object.assign(handlers, set.handlers);
  }

  return {
    schemas,
    async run(name, input) {
      const fn = handlers[name];
      if (!fn) return { error: `Unknown tool: ${name}` };
      return fn(input, context);
    },
  };
}
