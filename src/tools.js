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

function isAdminUser(context) {
  const allow = (process.env.ADMIN_USER_IDS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
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

// Build a toolkit for a surface: the always-on core set (memory) plus the named
// surface tool sets. `context` ({ userId, surface }) is passed to every handler.
// Unknown tool-set names are ignored (a surface can reference sets not built yet).
export function buildToolkit(toolSetNames = [], context = {}) {
  const schemas = [...coreSchemas];
  const handlers = { ...coreHandlers };

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
