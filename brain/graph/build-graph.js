#!/usr/bin/env node
// Builds graph/graph.json from concepts/ and entities/.
// Nodes come from files. Edges come from frontmatter `links` and inline [[wikilinks]].
// Zero dependencies. Run: node graph/build-graph.js

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DIRS = ["concepts", "entities"];

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const fm = {};
  let currentKey = null;
  for (const line of m[1].split(/\r?\n/)) {
    const listItem = line.match(/^\s+-\s+(.*)$/);
    if (listItem && currentKey) {
      if (!Array.isArray(fm[currentKey])) fm[currentKey] = [];
      fm[currentKey].push(stripComment(listItem[1]));
      continue;
    }
    const kv = line.match(/^([A-Za-z_][\w]*):\s*(.*)$/);
    if (kv) {
      currentKey = kv[1];
      let val = stripComment(kv[2]);
      if (val.startsWith("[") && val.endsWith("]")) {
        val = val
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
          .filter(Boolean);
      }
      fm[currentKey] = val;
    }
  }
  return fm;
}

function stripComment(s) {
  return s.replace(/\s+#.*$/, "").trim().replace(/^['"]|['"]$/g, "");
}

function wikilinks(text) {
  const body = text.replace(/^---[\s\S]*?---/, "");
  return [...body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)].map((m) =>
    m[1].trim()
  );
}

const nodes = [];
const edges = [];
const seen = new Set();

for (const dir of DIRS) {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) continue;
  for (const f of fs.readdirSync(full)) {
    if (!f.endsWith(".md")) continue;
    const text = fs.readFileSync(path.join(full, f), "utf8");
    const fm = parseFrontmatter(text);
    const id = (fm.id || f.replace(/\.md$/, "")).toString();
    if (seen.has(id)) {
      console.warn(`duplicate id skipped: ${id} (${dir}/${f})`);
      continue;
    }
    seen.add(id);
    nodes.push({
      id,
      title: fm.title || id,
      kind: dir === "concepts" ? "concept" : "entity",
      type: fm.type || null,
      status: fm.status || null,
      confidence: fm.confidence != null && fm.confidence !== "" ? Number(fm.confidence) : null,
      tracy_ready: fm.tracy_ready === "true" || fm.tracy_ready === true,
      tags: Array.isArray(fm.tags) ? fm.tags : [],
      file: `${dir}/${f}`,
    });
    const targets = new Set(
      [
        ...(Array.isArray(fm.links) ? fm.links : typeof fm.links === "string" && fm.links ? [fm.links] : []),
        ...wikilinks(text),
      ].map((t) => t.replace(/^\[\[|\]\]$/g, "").trim())
    );
    for (const t of targets) {
      if (t && t !== id) edges.push({ source: id, target: t });
    }
  }
}

const ids = new Set(nodes.map((n) => n.id));
const valid = edges.filter((e) => ids.has(e.target));
const dangling = [...new Set(edges.filter((e) => !ids.has(e.target)).map((e) => `${e.source} -> ${e.target}`))];

const graph = {
  generated: new Date().toISOString(),
  counts: { nodes: nodes.length, edges: valid.length, dangling: dangling.length },
  nodes,
  edges: valid,
  dangling,
};

fs.writeFileSync(path.join(__dirname, "graph.json"), JSON.stringify(graph, null, 2));
console.log(
  `graph.json written: ${nodes.length} nodes, ${valid.length} edges, ${dangling.length} dangling links`
);
if (dangling.length) {
  console.log("dangling (linked but no file yet):");
  for (const d of dangling) console.log("  " + d);
}
