// Documents — Tracy creates files (Markdown, PDF, Word) and reads uploaded ones.
//
// Creating: Tracy writes Markdown; this renders it to the requested format
// with a small block-level Markdown reader (headings, paragraphs, bullet and
// numbered lists, code blocks, rules, bold/italic inline) and stores the bytes
// so the person can download it from a link in her reply. Storage: Postgres
// `files` (bytea) when DATABASE_URL is set, else logs/files/. Ids are long and
// random, so a download link is a capability: unguessable, no login prompt.
//
// Reading: extracts plain text from uploads — PDF (pdf-parse), Word (mammoth),
// everything else as UTF-8 — so it can go into the knowledge base.
//
// Renderers are imported lazily: a host without them just can't make that
// format, nothing else breaks.

import crypto from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { dbEnabled, query } from "./db.js";
import { extractPdfText } from "./pdf.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILES_DIR = path.join(__dirname, "..", "logs", "files");
const MAX_MD_CHARS = 200000;

export const FORMATS = {
  md:   { mime: "text/markdown", ext: "md" },
  pdf:  { mime: "application/pdf", ext: "pdf" },
  docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: "docx" },
};

// ---- Markdown → blocks ----
export function parseMarkdown(md) {
  const lines = String(md || "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let para = [], list = null, code = null;
  const flushPara = () => { if (para.length) { blocks.push({ type: "p", text: para.join(" ") }); para = []; } };
  const flushList = () => { if (list) { blocks.push(list); list = null; } };
  for (const raw of lines) {
    const line = raw.replace(/\t/g, "    ");
    if (code) {
      if (/^```/.test(line)) { blocks.push(code); code = null; } else code.lines.push(raw);
      continue;
    }
    if (/^```/.test(line)) { flushPara(); flushList(); code = { type: "code", lines: [] }; continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flushPara(); flushList(); blocks.push({ type: "h", level: h[1].length, text: h[2].trim() }); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushPara(); flushList(); blocks.push({ type: "hr" }); continue; }
    const li = line.match(/^\s*(?:[-*+]|(\d+)[.)])\s+(.*)$/);
    if (li) {
      flushPara();
      const ordered = Boolean(li[1]);
      if (!list || list.ordered !== ordered) { flushList(); list = { type: "list", ordered, items: [] }; }
      list.items.push(li[2].trim());
      continue;
    }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if (list && /^\s{2,}/.test(line)) { list.items[list.items.length - 1] += " " + line.trim(); continue; }
    flushList();
    para.push(line.trim());
  }
  if (code) blocks.push(code);
  flushPara(); flushList();
  return blocks;
}

// Inline markup → runs of { text, bold, italic, code } (for PDF/DOCX).
export function inlineRuns(text) {
  const runs = [];
  const re = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*]+\*|_[^_]+_)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) runs.push({ text: text.slice(last, m.index) });
    const t = m[0];
    if (t.startsWith("**") || t.startsWith("__")) runs.push({ text: t.slice(2, -2), bold: true });
    else if (t.startsWith("`")) runs.push({ text: t.slice(1, -1), code: true });
    else runs.push({ text: t.slice(1, -1), italic: true });
    last = m.index + t.length;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs.length ? runs : [{ text }];
}
const plain = (text) => inlineRuns(text).map((r) => r.text).join("");

// ---- Renderers ----
async function renderPdf(blocks, title) {
  const { default: PDFDocument } = await import("pdfkit");
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margins: { top: 64, bottom: 64, left: 64, right: 64 }, info: { Title: title, Author: "Tracy (Interverse)" } });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    const body = (runs, opts = {}) => {
      runs.forEach((r, i) => {
        const font = r.code ? "Courier" : r.bold && r.italic ? "Helvetica-BoldOblique" : r.bold ? "Helvetica-Bold" : r.italic ? "Helvetica-Oblique" : "Helvetica";
        doc.font(font).fontSize(opts.size || 11).fillColor("#1a1a1a")
           .text(r.text, { continued: i < runs.length - 1, ...(i === 0 ? opts : {}) });
      });
    };
    if (title) { doc.font("Helvetica-Bold").fontSize(20).fillColor("#111").text(title); doc.moveDown(0.6); }
    for (const b of blocks) {
      if (b.type === "h") {
        const size = [20, 16, 13.5, 12, 11.5, 11][Math.min(b.level, 6) - 1];
        doc.moveDown(b.level <= 2 ? 0.8 : 0.5);
        doc.font("Helvetica-Bold").fontSize(size).fillColor("#111").text(plain(b.text));
        doc.moveDown(0.3);
      } else if (b.type === "p") {
        body(inlineRuns(b.text), { lineGap: 3 }); doc.moveDown(0.7);
      } else if (b.type === "list") {
        b.items.forEach((item, i) => {
          const marker = b.ordered ? `${i + 1}.  ` : "•  ";
          doc.font("Helvetica").fontSize(11).fillColor("#1a1a1a").text(marker, { continued: true, indent: 12 });
          body(inlineRuns(item), { lineGap: 2 });
        });
        doc.moveDown(0.6);
      } else if (b.type === "code") {
        doc.font("Courier").fontSize(9.5).fillColor("#222").text(b.lines.join("\n"), { lineGap: 1 });
        doc.moveDown(0.7);
      } else if (b.type === "hr") {
        doc.moveDown(0.3);
        doc.moveTo(doc.x, doc.y).lineTo(doc.page.width - 64, doc.y).strokeColor("#bbb").stroke();
        doc.moveDown(0.6);
      }
    }
    doc.end();
  });
}

async function renderDocx(blocks, title) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await import("docx");
  const runsOf = (text, mono = false) => inlineRuns(text).map((r) => new TextRun({
    text: r.text, bold: Boolean(r.bold), italics: Boolean(r.italic), font: r.code || mono ? "Consolas" : undefined,
  }));
  const H = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
  const children = [];
  if (title) children.push(new Paragraph({ text: title, heading: HeadingLevel.TITLE }));
  for (const b of blocks) {
    if (b.type === "h") children.push(new Paragraph({ children: runsOf(b.text), heading: H[Math.min(b.level, 6) - 1] }));
    else if (b.type === "p") children.push(new Paragraph({ children: runsOf(b.text), spacing: { after: 160 } }));
    else if (b.type === "list") b.items.forEach((item) => children.push(new Paragraph({ children: runsOf(item), [b.ordered ? "numbering" : "bullet"]: b.ordered ? { reference: "nums", level: 0 } : { level: 0 } })));
    else if (b.type === "code") b.lines.forEach((l) => children.push(new Paragraph({ children: [new TextRun({ text: l || " ", font: "Consolas", size: 19 })] })));
    else if (b.type === "hr") children.push(new Paragraph({ text: "", border: { bottom: { style: "single", size: 6, color: "BBBBBB", space: 1 } } }));
  }
  const doc = new Document({
    creator: "Tracy (Interverse)", title: title || "Document",
    numbering: { config: [{ reference: "nums", levels: [{ level: 0, format: "decimal", text: "%1.", alignment: "left" }] }] },
    sections: [{ children }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

// ---- Storage ----
let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = query(`
      CREATE TABLE IF NOT EXISTS files (
        id         TEXT PRIMARY KEY,
        user_id    TEXT,
        name       TEXT NOT NULL,
        mime       TEXT NOT NULL,
        size       INTEGER NOT NULL,
        bytes      BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `).catch((err) => { schemaReady = null; throw err; });
  }
  return schemaReady;
}
const safeName = (s, ext) => (String(s || "document").replace(/[^\w.\- ]+/g, "").trim().slice(0, 80) || "document").replace(new RegExp(`\\.${ext}$`, "i"), "") + "." + ext;

async function storeFile({ userId, name, mime, bytes }) {
  const id = crypto.randomBytes(16).toString("hex");
  if (dbEnabled()) {
    await ensureSchema();
    await query("INSERT INTO files (id, user_id, name, mime, size, bytes) VALUES ($1,$2,$3,$4,$5,$6)", [id, userId || null, name, mime, bytes.length, bytes]);
  } else {
    mkdirSync(FILES_DIR, { recursive: true });
    writeFileSync(path.join(FILES_DIR, id), bytes);
    writeFileSync(path.join(FILES_DIR, id + ".json"), JSON.stringify({ userId, name, mime, size: bytes.length }));
  }
  return { id, name, mime, size: bytes.length };
}

export async function getFile(id) {
  const key = String(id || "");
  if (!/^[0-9a-f]{32}$/.test(key)) return null;
  if (dbEnabled()) {
    await ensureSchema();
    const { rows } = await query("SELECT name, mime, bytes FROM files WHERE id = $1", [key]);
    return rows[0] ? { name: rows[0].name, mime: rows[0].mime, bytes: rows[0].bytes } : null;
  }
  const meta = path.join(FILES_DIR, key + ".json");
  if (!existsSync(meta)) return null;
  const m = JSON.parse(readFileSync(meta, "utf8"));
  return { name: m.name, mime: m.mime, bytes: readFileSync(path.join(FILES_DIR, key)) };
}

// Create a document from Markdown in the requested format. Returns { id, name, mime, size }.
export async function createDocument({ userId, title, markdown, format = "md" }) {
  const fmt = FORMATS[String(format || "md").toLowerCase()];
  if (!fmt) throw new Error(`Unsupported format '${format}' (use md, pdf, or docx).`);
  const md = String(markdown || "").trim();
  if (!md) throw new Error("Document content is empty.");
  if (md.length > MAX_MD_CHARS) throw new Error(`Document too long (max ${MAX_MD_CHARS} characters).`);
  const name = safeName(title, fmt.ext);
  let bytes;
  if (fmt.ext === "md") bytes = Buffer.from((title ? `# ${title}\n\n` : "") + md + "\n", "utf8");
  else if (fmt.ext === "pdf") bytes = await renderPdf(parseMarkdown(md), title);
  else bytes = await renderDocx(parseMarkdown(md), title);
  return storeFile({ userId, name, mime: fmt.mime, bytes });
}

// ---- Reading uploads ----
export async function extractText({ filename, buffer }) {
  const ext = String(filename || "").toLowerCase().split(".").pop();
  if (ext === "pdf") return extractPdfText(buffer);
  if (ext === "docx") {
    const mammoth = (await import("mammoth")).default;
    const r = await mammoth.extractRawText({ buffer });
    return String(r.value || "").trim();
  }
  if (ext === "html" || ext === "htm") {
    return buffer.toString("utf8").replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  }
  return buffer.toString("utf8").trim(); // md, txt, csv, json, code…
}
