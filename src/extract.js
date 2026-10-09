// Stateless text extraction for DualRep (POST /ai/extract).
//
// DualRep's worker sends a short-lived signed Storage URL (or a web link) and
// gets back per-page text chunks it stores in its own database. Tracy stores
// nothing: the file lives only in memory for this one request, and the route
// logs metadata only (format, byte and page counts), never text.
// Page numbers are kept end to end, because every DualRep card cites a page.
// Pages without a text layer (scans, photos) are flagged so the worker can
// send them to the dualrep_transcribe_pdf_pages task instead.
//
// Top-level imports are Node built-ins only (pdf.js loads pdf-parse lazily),
// so tests/extract.test.js runs without node_modules.

import dns from "node:dns/promises";
import net from "node:net";
import { extractPdfPages, renderPdfPagesPng } from "./pdf.js";

// A positive whole number from an env var, else the default. A typo in a
// Render setting must not turn a limit into NaN (which compares as "no limit").
function envInt(value, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function extractLimits(env = process.env) {
  return {
    maxBytes: envInt(env.EXTRACT_MAX_BYTES, 25 * 1024 * 1024), // per storage download (the bucket's own cap)
    maxLinkBytes: envInt(env.EXTRACT_MAX_LINK_BYTES, 5 * 1024 * 1024), // per web page
    maxPages: envInt(env.EXTRACT_MAX_PAGES, 100), // per call; the worker pages through with first_page
    timeoutMs: envInt(env.EXTRACT_TIMEOUT_MS, 20000), // the download, redirects included
    // Parsing stops starting new pages after this long and returns what it
    // has (last_page says where it stopped). Render's free plan has 0.1 CPU
    // and the worker gives each call about 110 s, so a big window must not
    // run past that and be retried forever.
    budgetMs: envInt(env.EXTRACT_BUDGET_MS, 60000),
    minPageChars: envInt(env.EXTRACT_MIN_PAGE_CHARS, 10), // fewer letters/digits than this = needs transcription
  };
}

function fail(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

// ---- Chunking ----
// Like knowledge.js chunkText (~900 characters, nearest heading as title),
// with two fixes that matter for per-page text: pdf-parse separates lines with
// single newlines, so a page is often one "paragraph"; a paragraph longer than
// `max` is split on lines, then sentences, then hard. And a chunk is labelled
// with the heading it was written under, not the next one. knowledge.js keeps
// its own version: the knowledge base depends on its exact output.
export function chunkPageText(text, { target = 900, max = 1600 } = {}) {
  const paras = String(text || "").replace(/\r\n/g, "\n").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const pieces = [];
  for (const p of paras) {
    if (p.length <= max) { pieces.push(p); continue; }
    let buf = "";
    for (const part of p.split(/\n|(?<=[.!?])\s+/)) {
      for (let s = part; s.length; s = s.slice(max)) {
        const bit = s.slice(0, max);
        if (buf && (buf + " " + bit).length > target) { pieces.push(buf); buf = bit; }
        else buf = buf ? buf + " " + bit : bit;
      }
    }
    if (buf) pieces.push(buf);
  }
  const chunks = [];
  let buf = "", bufTitle = "", title = "";
  for (const p of pieces) {
    const heading = /^#{1,6}\s/.test(p) ? p.replace(/^#{1,6}\s+/, "").split("\n")[0].trim() : null;
    if (buf && (buf + "\n\n" + p).length > target) { chunks.push({ title: bufTitle, content: buf }); buf = ""; }
    if (heading) title = heading;
    if (!buf) bufTitle = title;
    buf = buf ? buf + "\n\n" + p : p;
  }
  if (buf) chunks.push({ title: bufTitle, content: buf });
  return chunks;
}

// ---- HTML to text ----
const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
};
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]{1,8}|#\d{1,8}|[a-z]{1,32});/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// Elements whose whole content is dropped (page chrome, code, metadata).
const SKIP_ELEMENTS = new Set(["head", "title", "script", "style", "noscript", "svg", "nav", "header", "footer",
  "aside", "form", "template", "iframe"]);
// Closing one of these ends a paragraph.
const BLOCK_ELEMENTS = new Set(["p", "div", "section", "article", "li", "ul", "ol", "table", "tr", "blockquote",
  "pre", "dd", "dt"]);

// A small tag scanner rather than regex replacements: web pages are untrusted,
// and regexes like <script[\s\S]*?</script> go quadratic on a page full of
// unclosed tags, which would stall Tracy's single CPU for every caller. Every
// step here moves forward through the string, so the work is linear.
// Headings become "# ..." lines so chunk titles survive; block ends become
// blank lines; entities are decoded at the end.
export function htmlToText(html) {
  const src = String(html || "");
  const lower = src.toLowerCase();

  let title = "";
  const t = lower.indexOf("<title");
  if (t !== -1) {
    const open = src.indexOf(">", t);
    const close = open === -1 ? -1 : lower.indexOf("</title", open);
    if (close !== -1) title = decodeEntities(src.slice(open + 1, close)).replace(/\s+/g, " ").trim();
  }

  const out = [];
  let heading = 0; // level of the open <hN>, 0 = none
  let headingText = [];
  const emit = (s) => { if (heading) headingText.push(s); else out.push(s); };
  const closeHeading = () => {
    if (!heading) return;
    const text = headingText.join("").replace(/\s+/g, " ").trim();
    out.push(text ? `\n\n${"#".repeat(heading)} ${text}\n\n` : "\n\n");
    heading = 0;
    headingText = [];
  };

  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt === -1) { emit(src.slice(i)); break; }
    if (lt > i) emit(src.slice(i, lt));
    if (lower.startsWith("<!--", lt)) {
      const end = lower.indexOf("-->", lt + 4);
      if (end === -1) break; // an unclosed comment hides the rest, as in a browser
      emit(" ");
      i = end + 3;
      continue;
    }
    const next = src[lt + 1] || "";
    if (next === "!" || next === "?") { // <!DOCTYPE …>, <![CDATA[…]]>, <?xml …?>
      const gt = src.indexOf(">", lt);
      if (gt === -1) break;
      i = gt + 1;
      continue;
    }
    const m = /^<(\/?)([a-z][a-z0-9-]*)/.exec(lower.slice(lt, lt + 40));
    if (!m) { emit("<"); i = lt + 1; continue; } // "a < b" is text, not a tag
    const gt = src.indexOf(">", lt);
    if (gt === -1) break; // a tag that never closes: drop the rest
    const closing = m[1] === "/";
    const name = m[2];
    i = gt + 1;

    if (!closing && SKIP_ELEMENTS.has(name)) {
      if (src[gt - 1] === "/") continue; // self-closing, e.g. <svg … />
      const end = lower.indexOf("</" + name, i);
      if (end === -1) break; // never closed: the rest is inside it
      const endGt = src.indexOf(">", end);
      if (endGt === -1) break;
      emit(" ");
      i = endGt + 1;
      continue;
    }
    const level = /^h([1-6])$/.exec(name);
    if (level) {
      if (closing) closeHeading();
      else { closeHeading(); heading = Number(level[1]); }
      continue;
    }
    if (!closing && name === "li") emit("\n- ");
    else if (!closing && name === "br") emit("\n");
    else if (closing && BLOCK_ELEMENTS.has(name)) emit("\n\n");
    else if (closing && (name === "td" || name === "th")) emit("\t");
    else emit(" ");
  }
  closeHeading();

  const text = decodeEntities(out.join(""))
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text };
}

// ---- Fetching ----
// Only https, only public addresses, a byte cap and a timeout. Redirects are
// followed by hand (at most 3) so each hop is checked again. Storage files
// (pdf, doc) must come from DUALREP_STORAGE_HOSTS; a redirect from there may
// go to any public host (Storage could sit behind a CDN).
// Residual risk: DNS can change between this check and fetch's own lookup
// (rebinding). Pinning the address needs undici's Agent; acceptable for now
// because Tracy's Render service exposes nothing on its private network.
export function isPrivateAddress(ip) {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (v === 6) {
    const x = ip.toLowerCase().replace(/%.*$/, ""); // drop a zone id (fe80::1%eth0)
    if (x === "::" || x === "::1") return true;
    // IPv4 inside IPv6: ::ffff:10.0.0.1, ::ffff:a00:1 and the old ::10.0.0.1 form.
    const dotted = x.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted) return isPrivateAddress(dotted[1]);
    const hex = x.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
      return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    // ULA fc00::/7, link-local fe80::/10, old site-local fec0::/10, multicast ff00::/8.
    return /^(fc|fd|fe[89a-f]|ff)/.test(x);
  }
  return true; // not an IP at all: refuse
}

// The hosts DualRep's signed Storage URLs may come from. Empty = none: pdf
// and doc extraction (and the transcription tasks) stay closed until the
// founder sets DUALREP_STORAGE_HOSTS on Render.
export function storageHosts(env = process.env) {
  return String(env.DUALREP_STORAGE_HOSTS || "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
}

export async function checkUrl(raw, { kind, env = process.env, lookup = dns.lookup } = {}) {
  let u;
  try { u = new URL(String(raw)); } catch { throw fail(400, "bad_url", "url is not a valid URL"); }
  if (u.protocol !== "https:") throw fail(400, "bad_url", "url must be https");
  if (u.username || u.password) throw fail(400, "bad_url", "url must not carry credentials");
  if (kind !== "link") {
    const hosts = storageHosts(env);
    if (!hosts.length || !hosts.includes(u.host.toLowerCase())) throw fail(400, "bad_url", "url host is not an allowed storage host");
  }
  // An IPv6 literal keeps its brackets in URL.hostname; resolve it bare.
  const addrs = await lookup(u.hostname.replace(/^\[(.*)\]$/, "$1"), { all: true }).catch(() => []);
  if (!addrs.length) throw fail(422, "fetch_failed", "the host could not be resolved");
  if (addrs.some((a) => isPrivateAddress(a.address))) throw fail(400, "bad_url", "url points at a private address");
  return u;
}

export async function fetchLimited(raw, { kind, maxBytes, timeoutMs, env = process.env, fetchImpl = fetch, lookup } = {}) {
  let url = raw;
  const signal = AbortSignal.timeout(timeoutMs); // one deadline for every hop and the body
  for (let hop = 0; hop <= 3; hop++) {
    await checkUrl(url, { kind: hop === 0 ? kind : "link", env, lookup });
    let res;
    try {
      res = await fetchImpl(url, { redirect: "manual", signal, headers: { "user-agent": "TracyExtract/1.0", accept: "text/html,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain;q=0.8,*/*;q=0.1" } });
    } catch (err) {
      throw fail(422, err?.name === "TimeoutError" ? "timeout" : "fetch_failed", "the file could not be downloaded");
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      await res.body?.cancel().catch(() => {}); // free the connection
      try { url = new URL(res.headers.get("location"), url).toString(); }
      catch { throw fail(422, "fetch_failed", "the file could not be downloaded (bad redirect)"); }
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw fail(422, "fetch_failed", `the file could not be downloaded (HTTP ${res.status})`);
    }
    const declared = Number(res.headers.get("content-length") || 0);
    if (declared > maxBytes) {
      await res.body?.cancel().catch(() => {});
      throw fail(413, "too_large", `the file is larger than ${maxBytes} bytes`);
    }
    const parts = [];
    let size = 0;
    if (res.body) {
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) { await reader.cancel().catch(() => {}); throw fail(413, "too_large", `the file is larger than ${maxBytes} bytes`); }
          parts.push(value);
        }
      } catch (err) {
        if (err?.code === "too_large") throw err;
        throw fail(422, err?.name === "TimeoutError" ? "timeout" : "fetch_failed", "the file could not be downloaded");
      }
    }
    return { buffer: Buffer.concat(parts), contentType: (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase(), finalUrl: url };
  }
  throw fail(422, "fetch_failed", "too many redirects");
}

// ---- Extraction ----
// Letters and digits only, so a page of stray marks or page furniture counts
// as empty. Counted by deleting the rest (one string, not one array entry per
// character, on pages that can be megabytes).
const letters = (s) => String(s).replace(/[^\p{L}\p{N}]/gu, "").length;

function pageEntry(page, text, limits) {
  const count = letters(text);
  const needs = count < limits.minPageChars; // scans and photos have no text layer
  return {
    page,
    chars: text.length,
    letters: count,
    needs_transcription: needs,
    chunks: needs ? [] : chunkPageText(text).map((c, i) => ({ ordinal: i, title: c.title, content: c.content })),
  };
}

function sniff(buffer, contentType) {
  if (buffer.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (buffer.subarray(0, 2).toString("latin1") === "PK" && /word|officedocument|octet-stream|zip|^$/.test(contentType)) return "docx";
  if (/html/.test(contentType)) return "html";
  if (/^text\/(plain|markdown)$/.test(contentType)) return "text";
  return null;
}

async function defaultLoadMammoth() {
  try {
    return (await import("mammoth")).default;
  } catch {
    throw fail(503, "doc_unavailable", "document support isn't available on this server");
  }
}

// buffer + kind -> { format, total_pages, first_page, last_page, title, pages[] }
//   pdf: one entry per page in [firstPage, firstPage + maxPages - 1], fewer if
//        the parse budget ran out (last_page says where it stopped)
//   docx, html, text: one entry with page null (they have no pages)
export async function extractFromBuffer({ buffer, contentType = "", kind, firstPage = 1, maxPages }, { limits, pdf = { extractPdfPages }, loadMammoth = defaultLoadMammoth, now = Date.now } = {}) {
  const format = sniff(buffer, contentType);
  if (!format) throw fail(415, "unsupported_type", "this file type can't be read (send PDF, DOCX, HTML or plain text)");
  if (kind === "pdf" && format !== "pdf") throw fail(415, "unsupported_type", "kind is pdf but the file is not a PDF");
  if (format === "pdf") {
    const windowSize = Math.min(maxPages || limits.maxPages, limits.maxPages);
    const last = firstPage + windowSize - 1;
    let r;
    try {
      r = await pdf.extractPdfPages(buffer, { first: firstPage, last, deadline: now() + limits.budgetMs });
    } catch (err) {
      if (err?.code === "pdf_unavailable") throw fail(503, "pdf_unavailable", "PDF support isn't available on this server");
      if (/password/i.test(err?.name || "") || /password/i.test(err?.message || "")) throw fail(422, "pdf_encrypted", "the PDF is password-protected");
      throw fail(422, "pdf_unreadable", "the PDF could not be read");
    }
    const pages = r.pages.map((p) => pageEntry(p.num, p.text, limits));
    const lastPage = pages.length ? pages[pages.length - 1].page : Math.min(last, r.total);
    return { format, total_pages: r.total, first_page: firstPage, last_page: lastPage, title: "", pages };
  }
  let title = "", text;
  if (format === "docx") {
    const mammoth = await loadMammoth();
    const r = await mammoth.convertToHtml({ buffer }).catch(() => { throw fail(422, "doc_unreadable", "the document could not be read"); });
    text = htmlToText(r.value).text; // via HTML so headings survive as chunk titles
  } else if (format === "html") {
    ({ title, text } = htmlToText(buffer.toString("utf8")));
  } else {
    text = buffer.toString("utf8");
  }
  const entry = pageEntry(null, text, limits);
  if (entry.needs_transcription) throw fail(422, "no_text", "no readable text was found");
  return { format, total_pages: null, first_page: null, last_page: null, title, pages: [entry] };
}

// For dualrep_transcribe_pdf_pages: download the signed URL and render the
// requested pages to PNG in memory. Only those pages are sent to Claude, so a
// 4-page call on a 300-page scan bills 4 images, not 300 pages.
export function makeRenderPdfPages({ env = process.env, fetchImpl, lookup, render = renderPdfPagesPng } = {}) {
  return async (url, pages) => {
    const limits = extractLimits(env);
    const { buffer } = await fetchLimited(url, { kind: "pdf", maxBytes: limits.maxBytes, timeoutMs: limits.timeoutMs, env, fetchImpl, lookup });
    if (buffer.subarray(0, 5).toString("latin1") !== "%PDF-") throw fail(415, "unsupported_type", "the file is not a PDF");
    const width = envInt(env.DUALREP_RENDER_WIDTH, 1568);
    let shots;
    try {
      shots = await render(buffer, pages, { width });
    } catch (err) {
      if (err?.code === "pdf_unavailable") throw fail(503, "pdf_unavailable", "PDF support isn't available on this server");
      if (/password/i.test(err?.name || "") || /password/i.test(err?.message || "")) throw fail(422, "pdf_encrypted", "the PDF is password-protected");
      throw fail(422, "pdf_unreadable", "the PDF pages could not be rendered");
    }
    // pdf-parse silently skips pages past the end; say so instead of asking
    // the model to transcribe a page it never sees.
    const got = new Set((shots || []).map((s) => s.page));
    if (!pages.every((p) => got.has(p))) throw fail(422, "page_out_of_range", "a requested page is not in the PDF");
    return pages.map((p) => shots.find((s) => s.page === p));
  };
}
