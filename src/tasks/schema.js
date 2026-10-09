// Shared helpers for task output schemas and validators.
//
// Node built-ins only (like src/aitasks.js), so the task tests run without
// node_modules. Validator messages name fields and indexes, never content:
// they reach logs and the caller's job table, and DualRep's study material
// must not leak through an error string.

export function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function isNonEmptyString(v, max = Infinity) {
  return typeof v === "string" && v.trim() !== "" && v.length <= max;
}

// Structured outputs (output_config.format) accept a subset of JSON Schema:
// every object needs additionalProperties:false, and minimum/maximum,
// minLength/maxLength, maxItems and minItems > 1 are rejected with a 400.
// Bounds therefore live in the validators, and this lint keeps a schema
// edit from shipping something the API refuses. It also insists every
// property is required (an "optional" field is a {anyOf:[T,{type:"null"}]}
// union), because the API's limit on optional parameters is small.
// Returns a list of problems ([] = fine). Used by the tests.
const BANNED_KEYWORDS = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minLength", "maxLength", "maxItems", "uniqueItems", "patternProperties", "if", "then", "else", "not"];

export function lintStructuredSchema(schema, path = "$") {
  const problems = [];
  if (!isPlainObject(schema)) return [`${path}: not an object`];
  for (const k of BANNED_KEYWORDS) if (k in schema) problems.push(`${path}: unsupported keyword ${k}`);
  if (schema.minItems !== undefined && schema.minItems !== 0 && schema.minItems !== 1) {
    problems.push(`${path}: minItems must be 0 or 1`);
  }
  if (schema.type === "object") {
    if (schema.additionalProperties !== false) problems.push(`${path}: additionalProperties must be false`);
    const props = schema.properties || {};
    const required = new Set(schema.required || []);
    for (const key of Object.keys(props)) {
      if (!required.has(key)) problems.push(`${path}.${key}: every property must be required (use a null union for optional)`);
      problems.push(...lintStructuredSchema(props[key], `${path}.${key}`));
    }
  }
  if (schema.type === "array" && schema.items) problems.push(...lintStructuredSchema(schema.items, `${path}[]`));
  for (const alt of schema.anyOf || []) problems.push(...lintStructuredSchema(alt, `${path}|`));
  return problems;
}

// Collapse whitespace and case so a quote copied across a line break (or
// with different capitalisation) still matches its source passage.
export function normalizeForMatch(s) {
  return String(s).replace(/\s+/g, " ").trim().toLowerCase();
}
