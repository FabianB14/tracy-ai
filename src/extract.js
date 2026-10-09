// Stateless text extraction for DualRep (POST /ai/extract).
//
// DualRep's worker sends a short-lived signed Storage URL (or a web link) and
// gets back per-page text chunks it stores in its own database. Tracy stores
// nothing on disk: the file lives only in memory (the last Storage file for up
// to 10 minutes, see makeDownloadCache), and the route logs metadata only
// (format, byte and page counts), never text.
// Page numbers are kept end to end, because every DualRep card cites a page.
// Pages without a text layer (scans, photos) are flagged so the worker can
// send them to the dualrep_transcribe_pdf_pages task instead.
//
// PDFs and .docx files are read in a child process with a memory and time
// limit (src/isolate.js): what a small upload unpacks to is not limited by
// its size, and Tracy's own process is shared with every other caller.
//
// Top-level imports are Node built-ins only (pdf.js loads pdf-parse lazily,
// and only inside the child), so tests/extract.test.js runs without
// node_modules.

import dns from "node:dns/promises";
import net from "node:net";
import { runIsolated } from "./isolate.js";

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
    // The child process that reads a PDF or .docx is killed past this much
    // private memory, or past what the instance has left if that is less
    // (src/isolate.js). Render's free plan has 512 MB for everything; Tracy
    // itself uses about 80-130 MB, and a scanned page renders in about
    // 230 MB (a 12 MP scan) to 340 MB (a 600 dpi copier page or a 24 MP
    // photo), however many pages the batch has (see renderPdfPagesJpeg).
    maxMemoryMb: envInt(env.EXTRACT_MAX_MEMORY_MB, 350),
    // Text per answer: a real 300-page book is about 1.5 million characters.
    // A PDF window stops early at this (last_page says where); a document or
    // web page with more is refused as too large.
    maxTextChars: envInt(env.EXTRACT_MAX_TEXT_CHARS, 3_000_000),
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

// Elements whose whole content is dropped (page chrome, code, metadata, the
// contents of form controls). Not <form>: ASP.NET and SharePoint pages (common
// on college sites) wrap the whole page in one, and the scanner never emits
// attribute values (such as __VIEWSTATE) anyway. A <template> is inert
// markup, except a declarative shadow root (<template shadowrootmode>), which
// is what the page shows.
const SKIP_ELEMENTS = new Set(["head", "title", "script", "style", "noscript", "svg", "nav", "header", "footer",
  "aside", "template", "iframe", "select", "textarea", "button"]);
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

    const shadowRoot = name === "template" && /\sshadowrootmode\s*=/.test(lower.slice(lt, gt));
    if (!closing && SKIP_ELEMENTS.has(name) && !shadowRoot) {
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
// founder sets DUALREP_STORAGE_HOSTS on Render. A pasted URL
// ("https://<ref>.supabase.co/") counts as its host.
export function storageHosts(env = process.env) {
  return String(env.DUALREP_STORAGE_HOSTS || "").split(",")
    .map((h) => h.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/[/?#].*$/, ""))
    .filter(Boolean);
}

// For /diag: whether every entry looks like a host name (e.g. abc.supabase.co).
export function storageHostsLookValid(env = process.env) {
  const hosts = storageHosts(env);
  return hosts.length > 0 && hosts.every((h) => /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?$/.test(h));
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

// DualRep reads a scanned PDF again for every 4-page batch it transcribes
// (and for every 100-page text window), and each full download counts against
// its Supabase project's monthly egress: a 25 MB, 200-page scan would cost
// about 1.3 GB. So the most recent Storage file stays in memory for a while
// (one file, refreshed on each use) and is revalidated with If-None-Match:
// Storage still checks the new signed URL's token and answers 304 (headers
// only) while the file is unchanged, or sends the new bytes. Links are never
// cached. Pass `cache: null` to fetchLimited to skip it.
export function makeDownloadCache({ ttlMs = 10 * 60_000, now = Date.now } = {}) {
  let entry = null; // { key, etag, buffer, contentType, at }
  return {
    get(key) {
      if (entry && now() - entry.at > ttlMs) entry = null;
      return entry && entry.key === key ? entry : null;
    },
    set(key, value) { entry = { key, ...value, at: now() }; },
    touch(key) { if (entry && entry.key === key) entry.at = now(); },
    clear() { entry = null; },
  };
}

export async function fetchLimited(raw, { kind, maxBytes, timeoutMs, env = process.env, fetchImpl = fetch, lookup, cache = null } = {}) {
  let url = raw;
  const signal = AbortSignal.timeout(timeoutMs); // one deadline for every hop and the body
  // The file's identity without the signed URL's token (the query string).
  let key = null;
  if (cache && kind !== "link") {
    try { const u = new URL(String(raw)); key = u.origin + u.pathname; } catch { key = null; }
  }
  const cached = key ? cache.get(key) : null;
  for (let hop = 0; hop <= 3; hop++) {
    await checkUrl(url, { kind: hop === 0 ? kind : "link", env, lookup });
    const headers = { "user-agent": "TracyExtract/1.0", accept: "text/html,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain;q=0.8,*/*;q=0.1" };
    if (cached) headers["if-none-match"] = cached.etag;
    let res;
    try {
      res = await fetchImpl(url, { redirect: "manual", signal, headers });
    } catch (err) {
      throw fail(422, err?.name === "TimeoutError" ? "timeout" : "fetch_failed", "the file could not be downloaded");
    }
    if (cached && res.status === 304) {
      await res.body?.cancel().catch(() => {});
      cache.touch(key);
      return { buffer: cached.buffer, contentType: cached.contentType, finalUrl: url, cached: true };
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
    const buffer = Buffer.concat(parts);
    const contentType = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const etag = res.headers.get("etag");
    if (key && etag) cache.set(key, { etag, buffer, contentType });
    return { buffer, contentType, finalUrl: url };
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

// The readers extractFromBuffer uses unless a test passes its own: pdf.js and
// mammoth, each in a child process (src/isolate.js) with the memory limit and
// a time limit of the parse budget plus a margin (the budget normally ends a
// PDF window early on its own; the margin covers one slow page).
function isolatedPdf(limits) {
  return {
    extractPdfPages: (buffer, args) => runIsolated("pdfText", buffer, args, { maxMemoryMb: limits.maxMemoryMb, timeoutMs: limits.budgetMs + 20_000 }),
  };
}
function isolatedMammoth(limits) {
  return {
    convertToHtml: async ({ buffer }) => ({ value: await runIsolated("docxHtml", buffer, {}, { maxMemoryMb: limits.maxMemoryMb, timeoutMs: limits.budgetMs + 20_000 }) }),
  };
}

// Errors that already carry their answer (busy 503, too_large 413 from the
// child's memory limit) go to the caller as they are.
const answered = (err) => Number.isInteger(err?.status) && typeof err?.code === "string";

// buffer + kind -> { format, total_pages, first_page, last_page, title, pages[] }
//   pdf: one entry per page in [firstPage, firstPage + maxPages - 1], fewer if
//        the parse budget ran out or the text limit was reached (last_page
//        says where it stopped)
//   docx, html, text: one entry with page null (they have no pages)
export async function extractFromBuffer({ buffer, contentType = "", kind, firstPage = 1, maxPages }, { limits, pdf = isolatedPdf(limits), loadMammoth = async () => isolatedMammoth(limits), now = Date.now } = {}) {
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
      if (answered(err)) throw err;
      if (err?.code === "pdf_unavailable") throw fail(503, "pdf_unavailable", "PDF support isn't available on this server");
      if (/password/i.test(err?.name || "") || /password/i.test(err?.message || "")) throw fail(422, "pdf_encrypted", "the PDF is password-protected");
      throw fail(422, "pdf_unreadable", "the PDF could not be read");
    }
    // Stop the window at the text limit (at least one page, so the caller
    // always moves on); a single page over it is refused.
    const kept = [];
    let chars = 0;
    for (const p of r.pages) {
      chars += String(p.text || "").length;
      if (chars > limits.maxTextChars) {
        if (!kept.length) throw fail(413, "too_large", "a page has more text than can be read at once");
        break;
      }
      kept.push(p);
    }
    const pages = kept.map((p) => pageEntry(p.num, p.text, limits));
    const lastPage = pages.length ? pages[pages.length - 1].page : Math.min(last, r.total);
    return { format, total_pages: r.total, first_page: firstPage, last_page: lastPage, title: "", pages };
  }
  let title = "", text;
  if (format === "docx") {
    const mammoth = await loadMammoth();
    const r = await mammoth.convertToHtml({ buffer }).catch((err) => {
      if (answered(err)) throw err;
      if (err?.code === "doc_unavailable") throw fail(503, "doc_unavailable", "document support isn't available on this server");
      throw fail(422, "doc_unreadable", "the document could not be read");
    });
    if (r.value.length > limits.maxTextChars * 4) throw fail(413, "too_large", "the document has more text than can be read at once");
    text = htmlToText(r.value).text; // via HTML so headings survive as chunk titles
  } else if (format === "html") {
    ({ title, text } = htmlToText(buffer.toString("utf8")));
  } else {
    text = buffer.toString("utf8");
  }
  if (text.length > limits.maxTextChars) throw fail(413, "too_large", "the document has more text than can be read at once");
  const entry = pageEntry(null, text, limits);
  if (entry.needs_transcription) throw fail(422, "no_text", "no readable text was found");
  return { format, total_pages: null, first_page: null, last_page: null, title, pages: [entry] };
}

// For dualrep_transcribe_pdf_pages: download the signed URL and render the
// requested pages to JPEG, in a child process (src/isolate.js), one page at a
// time. Only those pages are sent to Claude, so a 4-page call on a 300-page
// scan bills 4 images, not 300 pages. The render has its own time budget
// (DUALREP_RENDER_BUDGET_MS, 45 s): the model call keeps the rest of the
// task's 105 s (runTask takes preparation time off it), and a render that
// runs out of time is a 503 render_timeout the worker tries again later.
// A render killed for memory, or a page image over the API's per-image
// limit, is 413 page_too_large, not too_large: the file is fine, a page in
// it is too detailed to render here (a very high resolution scan). DualRep
// says so and lets the person skip that batch.
// `cache`: see makeDownloadCache (the batches of one scan reuse the file).
export function makeRenderPdfPages({ env = process.env, fetchImpl, lookup, render, cache = null } = {}) {
  return async (url, pages) => {
    const limits = extractLimits(env);
    const { buffer } = await fetchLimited(url, { kind: "pdf", maxBytes: limits.maxBytes, timeoutMs: limits.timeoutMs, env, fetchImpl, lookup, cache });
    if (buffer.subarray(0, 5).toString("latin1") !== "%PDF-") throw fail(415, "unsupported_type", "the file is not a PDF");
    const width = envInt(env.DUALREP_RENDER_WIDTH, 1568);
    const budgetMs = envInt(env.DUALREP_RENDER_BUDGET_MS, 45_000);
    const opts = { width, quality: 85, deadline: Date.now() + budgetMs };
    let shots;
    try {
      shots = render
        ? await render(buffer, pages, opts)
        : await runIsolated("pdfRender", buffer, { pages, ...opts }, { maxMemoryMb: limits.maxMemoryMb, timeoutMs: budgetMs + 15_000 });
    } catch (err) {
      if (err?.status === 413 && err.code === "too_large") throw fail(413, "page_too_large", "a page needs too much memory to render");
      if (answered(err)) throw err;
      if (err?.code === "render_timeout" || err?.code === "isolate_timeout") throw fail(503, "render_timeout", "rendering the pages took too long; try again");
      if (err?.code === "pdf_unavailable") throw fail(503, "pdf_unavailable", "PDF support isn't available on this server");
      if (/password/i.test(err?.name || "") || /password/i.test(err?.message || "")) throw fail(422, "pdf_encrypted", "the PDF is password-protected");
      throw fail(422, "pdf_unreadable", "the PDF pages could not be rendered");
    }
    // pdf-parse silently skips pages past the end; say so instead of asking
    // the model to transcribe a page it never sees.
    const got = new Set((shots || []).map((s) => s.page));
    if (!pages.every((p) => got.has(p))) throw fail(422, "page_out_of_range", "a requested page is not in the PDF");
    // The API refuses an image over 10 MB (base64) and a request over 32 MB;
    // JPEG pages are a few hundred KB, so only something pathological gets
    // near these. Refused here, the model is never asked (asking again would
    // send the same image).
    const big = shots.find((s) => String(s.data || "").length > MAX_IMAGE_BYTES);
    if (big) throw fail(413, "page_too_large", "a rendered page is too large to send");
    const bytes = shots.reduce((sum, s) => sum + String(s.data || "").length, 0);
    if (bytes > MAX_RENDER_BYTES) throw fail(413, "too_large", "the rendered pages are too large to send");
    return pages.map((p) => shots.find((s) => s.page === p));
  };
}

const MAX_RENDER_BYTES = 24 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
