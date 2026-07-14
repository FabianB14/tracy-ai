// Tracy's tools — the actions she can take on behalf of users.
//
// Tools are grouped into named TOOL SETS, one per capability area. Surfaces opt
// into the tool sets they need (see src/surfaces.js). Nothing here is loaded
// globally, and nothing assumes a specific client — a surface with no tool sets
// simply gets a Tracy who talks.
//
// Each tool has (1) a schema Claude sees, and (2) an implementation. The
// implementations below are STUBS: replace the TODO sections with real calls to
// the relevant backend/API. (Per project plan: BabyResell API wiring comes later.)

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
// Tool-set registry
// ---------------------------------------------------------------------------
// Add a new capability area by adding an entry here, then reference it from a
// surface in src/surfaces.js. Future: `carparts` (fitment lookup), etc.

export const toolSets = {
  babyresell: { schemas: babyresellSchemas, handlers: babyresellHandlers },
};

// Build a toolkit for a given list of tool-set names: merged schemas + a runner.
// Unknown tool-set names are ignored (a surface can reference sets not built yet).
export function buildToolkit(toolSetNames = []) {
  const schemas = [];
  const handlers = {};

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
      return fn(input);
    },
  };
}
