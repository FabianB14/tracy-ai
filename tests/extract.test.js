// Tests for src/extract.js and the per-page helpers in src/pdf.js
// (POST /ai/extract and the scanned-page renderer).
// The first group needs no dependencies: fake fetch, fake DNS, fake PDF
// reader. The last group runs the real pdf-parse / mammoth on documents made
// in memory with pdfkit / docx, and is skipped when node_modules is absent.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import zlib from "node:zlib";
import { chunkPageText, htmlToText, isPrivateAddress, checkUrl, fetchLimited, extractFromBuffer, extractLimits, makeRenderPdfPages, makeDownloadCache, storageHosts, storageHostsLookValid } from "../src/extract.js";

const ENV = { DUALREP_STORAGE_HOSTS: "abc.supabase.co" };
const publicDns = async () => [{ address: "104.18.1.1", family: 4 }];
const limits = extractLimits({});
const PDF_URL = "https://abc.supabase.co/storage/v1/object/sign/sources/u/s/1.pdf?token=t";

// ---- chunking ----

test("chunkPageText splits a long single-paragraph page and keeps each chunk under the cap", () => {
  const page = ("Photosynthesis converts light energy into chemical energy. ").repeat(60);
  const chunks = chunkPageText(page);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.content.length <= 1600));
  assert.equal(chunks.map((c) => c.content).join(" ").replace(/\s+/g, " ").trim(), page.replace(/\s+/g, " ").trim());
});

test("chunkPageText hard-cuts text with no sentence breaks and loses nothing", () => {
  const blob = "x".repeat(5000);
  const chunks = chunkPageText(blob);
  assert.ok(chunks.every((c) => c.content.length <= 1600));
  assert.equal(chunks.map((c) => c.content).join("").replace(/\s+/g, ""), blob);
});

test("chunkPageText labels a chunk with the heading it sits under", () => {
  const text = "# One\n\n" + "a".repeat(800) + "\n\n# Two\n\n" + "b".repeat(800);
  const chunks = chunkPageText(text);
  assert.deepEqual(chunks.map((c) => c.title), ["One", "Two"]);
  assert.deepEqual(chunkPageText(""), []);
});

// ---- HTML ----

test("htmlToText keeps headings and paragraphs, drops scripts and navigation, decodes entities", () => {
  const { title, text } = htmlToText("<!DOCTYPE html><html><head><title>Cells &amp; life</title><script>x()</script></head><body><nav>Home</nav><h2>Mitosis</h2><p>Cells&nbsp;divide.</p><p>Then &#8220;rest&#8221;.</p></body></html>");
  assert.equal(title, "Cells & life");
  assert.equal(text, "## Mitosis\n\nCells divide.\n\nThen “rest”.");
});

test("htmlToText handles lists, line breaks, comments, inline tags and stray angle brackets", () => {
  const { text } = htmlToText("<p>a < b and <b>bold</b><!-- hidden --> text<br>next</p><ul><li>one</li><li>two</li></ul><h1>Big <em>idea</em>\n here</h1><footer>(c)</footer>");
  assert.equal(text, "a < b and bold text\nnext\n\n- one\n\n- two\n\n# Big idea here");
});

test("htmlToText reads pages wrapped in a <form> (ASP.NET, SharePoint) and declarative shadow roots", () => {
  const aspx = `<html><body><form method="post" id="form1"><input type="hidden" name="__VIEWSTATE" value="dDwtMTA4NzE5MzQ2Mzs7Pg==" />
    <h1>Week 3: Osmosis</h1><p>Water moves across a membrane.</p><p>Toward the higher solute concentration.</p>
    <select name="term"><option>Fall</option></select><textarea>Type here</textarea><button>Search</button></form></body></html>`;
  const { text } = htmlToText(aspx);
  assert.equal(text, "# Week 3: Osmosis\n\nWater moves across a membrane.\n\nToward the higher solute concentration.");
  assert.ok(!text.includes("VIEWSTATE") && !text.includes("dDwt"), "attribute values never become text");
  assert.equal(htmlToText("<div><template shadowrootmode=\"open\"><p>Shown text.</p></template></div>").text, "Shown text.");
  assert.equal(htmlToText("<p>Kept.</p><template><p>Inert copy.</p></template>").text, "Kept.");
});

test("htmlToText stays fast on hostile markup (no quadratic regex)", () => {
  for (const evil of ["<nav>".repeat(200000), "<h1 ".repeat(200000), "<".repeat(1000000), "<script>".repeat(100000) + "x", "&amp".repeat(200000)]) {
    const t0 = Date.now();
    htmlToText(evil);
    assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms on ${JSON.stringify(evil.slice(0, 12))}…`);
  }
});

// ---- URLs and fetching ----

test("private and special addresses are refused", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1",
    "::1", "::", "fd00::1", "fe80::1", "fe80::1%eth0", "fec0::1", "ff02::1", "::ffff:10.0.0.1", "::ffff:7f00:1", "::127.0.0.1", "not-an-ip"]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["104.18.1.1", "2606:4700::6810:101", "::ffff:104.18.1.1"]) assert.equal(isPrivateAddress(ip), false, ip);
});

test("storage kinds must come from the allowed host; links must be https and public", async () => {
  assert.deepEqual(storageHosts({ DUALREP_STORAGE_HOSTS: " ABC.supabase.co , cdn.example " }), ["abc.supabase.co", "cdn.example"]);
  // A pasted URL counts as its host; /diag says when an entry still isn't a host name.
  assert.deepEqual(storageHosts({ DUALREP_STORAGE_HOSTS: "https://ABC.supabase.co/, abc.supabase.co/storage/v1" }), ["abc.supabase.co", "abc.supabase.co"]);
  assert.equal(storageHostsLookValid({ DUALREP_STORAGE_HOSTS: "https://abc.supabase.co/" }), true);
  assert.equal(storageHostsLookValid({ DUALREP_STORAGE_HOSTS: "abc supabase co" }), false);
  assert.equal(storageHostsLookValid({}), false);
  await checkUrl(PDF_URL, { kind: "pdf", env: ENV, lookup: publicDns });
  await assert.rejects(checkUrl("https://other.supabase.co/a.pdf", { kind: "pdf", env: ENV, lookup: publicDns }), (e) => e.code === "bad_url");
  await assert.rejects(checkUrl("https://abc.supabase.co/a.pdf", { kind: "doc", env: {}, lookup: publicDns }), (e) => e.code === "bad_url", "no allowlist = closed");
  await assert.rejects(checkUrl("https://u:p@abc.supabase.co/a.pdf", { kind: "pdf", env: ENV, lookup: publicDns }), (e) => e.code === "bad_url");
  await assert.rejects(checkUrl("http://example.com/", { kind: "link", env: ENV, lookup: publicDns }), (e) => e.code === "bad_url");
  await assert.rejects(checkUrl("https://intranet.example/", { kind: "link", env: ENV, lookup: async () => [{ address: "10.0.0.5" }] }), (e) => e.code === "bad_url");
  await assert.rejects(checkUrl("https://[::1]/", { kind: "link", env: ENV }), (e) => e.code === "bad_url", "an IPv6 literal is checked too");
  await assert.rejects(checkUrl("https://nowhere.invalid/", { kind: "link", env: ENV, lookup: async () => { throw new Error("ENOTFOUND"); } }), (e) => e.status === 422 && e.code === "fetch_failed");
});

test("downloads stop at the byte cap, declared or streamed", async () => {
  const opts = { kind: "pdf", maxBytes: 1024, timeoutMs: 1000, env: ENV, lookup: publicDns };
  const declared = new Response(new Uint8Array(2048), { status: 200, headers: { "content-type": "application/pdf", "content-length": "2048" } });
  await assert.rejects(fetchLimited(PDF_URL, { ...opts, fetchImpl: async () => declared }), (e) => e.status === 413 && e.code === "too_large");
  const streamed = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(800)); c.enqueue(new Uint8Array(800)); c.close(); } }), { status: 200 });
  await assert.rejects(fetchLimited(PDF_URL, { ...opts, fetchImpl: async () => streamed }), (e) => e.status === 413);
  const ok = await fetchLimited(PDF_URL, { ...opts, fetchImpl: async () => new Response("%PDF-1.7", { headers: { "content-type": "application/pdf; charset=binary" } }) });
  assert.equal(ok.buffer.toString(), "%PDF-1.7");
  assert.equal(ok.contentType, "application/pdf");
});

test("a Storage file is downloaded once and then revalidated (304), not downloaded per batch", async () => {
  const opts = { kind: "pdf", maxBytes: 1024, timeoutMs: 1000, env: ENV, lookup: publicDns };
  const cache = makeDownloadCache();
  const seen = [];
  let version = "v1";
  const fetchImpl = async (url, init) => {
    seen.push({ url, ifNoneMatch: init.headers["if-none-match"] ?? null });
    if (init.headers["if-none-match"] === `"${version}"`) return new Response(null, { status: 304 });
    return new Response(`%PDF-${version}`, { status: 200, headers: { etag: `"${version}"`, "content-type": "application/pdf" } });
  };
  const signed = (token) => `https://abc.supabase.co/storage/v1/object/sign/sources/u/s/1.pdf?token=${token}`;
  assert.equal((await fetchLimited(signed("a"), { ...opts, fetchImpl, cache })).buffer.toString(), "%PDF-v1");
  // The next batch has a new signed URL for the same file: Storage checks it and answers 304.
  const again = await fetchLimited(signed("b"), { ...opts, fetchImpl, cache });
  assert.deepEqual([again.buffer.toString(), again.cached], ["%PDF-v1", true]);
  assert.deepEqual(seen.map((x) => x.ifNoneMatch), [null, '"v1"']);
  // A changed file comes back in full and replaces the copy.
  version = "v2";
  assert.equal((await fetchLimited(signed("c"), { ...opts, fetchImpl, cache })).buffer.toString(), "%PDF-v2");
  // Another file, or a web link, is never answered from the copy.
  await fetchLimited("https://abc.supabase.co/storage/v1/object/sign/sources/u/s/2.pdf?token=d", { ...opts, fetchImpl, cache });
  assert.equal(seen.at(-1).ifNoneMatch, null);
  await fetchLimited("https://example.com/page", { ...opts, kind: "link", fetchImpl, cache });
  assert.equal(seen.at(-1).ifNoneMatch, null);
  // The copy expires.
  let now = 0;
  const short = makeDownloadCache({ ttlMs: 1000, now: () => now });
  short.set("k", { etag: "e", buffer: Buffer.from("x"), contentType: "" });
  now = 2000;
  assert.equal(short.get("k"), null);
});

test("redirects are re-checked, limited to 3, and HTTP errors are 422s", async () => {
  const opts = { kind: "link", maxBytes: 1024, timeoutMs: 1000, env: ENV };
  const redirect = (to) => async () => new Response(null, { status: 302, headers: { location: to } });
  const lookup = async (host) => (host === "internal.example" ? [{ address: "127.0.0.1" }] : [{ address: "104.18.1.1" }]);
  await assert.rejects(fetchLimited("https://example.com/", { ...opts, lookup, fetchImpl: redirect("https://internal.example/x") }), (e) => e.code === "bad_url");
  await assert.rejects(fetchLimited("https://example.com/", { ...opts, lookup, fetchImpl: redirect("/again") }), (e) => e.status === 422 && /redirects/.test(e.message));
  await assert.rejects(fetchLimited("https://example.com/", { ...opts, lookup, fetchImpl: async () => new Response("no", { status: 404 }) }), (e) => e.status === 422 && e.code === "fetch_failed");
  await assert.rejects(fetchLimited("https://example.com/", { ...opts, lookup, fetchImpl: async () => { throw new DOMException("t", "TimeoutError"); } }), (e) => e.code === "timeout");
});

// ---- extraction (fake PDF reader) ----

const fakePdf = (pages) => ({
  extractPdfPages: async (buf, { first, last }) => ({ total: pages.length, pages: pages.map((text, i) => ({ num: i + 1, text })).filter((p) => p.num >= first && p.num <= last) }),
});

test("PDF pages keep their numbers; pages without text are flagged for transcription", async () => {
  const pdf = fakePdf(["Chapter 1\nCells are small.", "  \n 12 ", "Ribosomes make proteins."]);
  const out = await extractFromBuffer({ buffer: Buffer.from("%PDF-1.7 ..."), contentType: "application/pdf", kind: "pdf" }, { limits, pdf });
  assert.equal(out.total_pages, 3);
  assert.equal(out.first_page, 1);
  assert.equal(out.last_page, 3);
  assert.deepEqual(out.pages.map((p) => [p.page, p.needs_transcription, p.chunks.length]), [[1, false, 1], [2, true, 0], [3, false, 1]]);
  assert.deepEqual(Object.keys(out.pages[0].chunks[0]), ["ordinal", "title", "content"]);
});

test("PDF windows: first_page, max_pages and the end of the file", async () => {
  const pdf = fakePdf(Array.from({ length: 10 }, (_, i) => `Page ${i + 1} has enough text.`));
  const buffer = Buffer.from("%PDF-1.7");
  let out = await extractFromBuffer({ buffer, kind: "pdf", firstPage: 4, maxPages: 3 }, { limits, pdf });
  assert.deepEqual([out.first_page, out.last_page, out.pages.map((p) => p.page)], [4, 6, [4, 5, 6]]);
  out = await extractFromBuffer({ buffer, kind: "pdf", firstPage: 9 }, { limits: { ...limits, maxPages: 5 }, pdf });
  assert.deepEqual([out.last_page, out.pages.length], [10, 2]);
  out = await extractFromBuffer({ buffer, kind: "pdf", firstPage: 11 }, { limits, pdf });
  assert.deepEqual([out.total_pages, out.pages.length], [10, 0], "past the end: nothing, no error");
  out = await extractFromBuffer({ buffer, kind: "pdf", maxPages: 500 }, { limits: { ...limits, maxPages: 2 }, pdf });
  assert.equal(out.pages.length, 2, "max_pages never exceeds EXTRACT_MAX_PAGES");
});

test("a parse that runs out of time reports where it stopped", async () => {
  const pdf = { extractPdfPages: async (buf, { first, deadline }) => {
    assert.equal(typeof deadline, "number");
    return { total: 50, pages: [{ num: first, text: "Only one page was read in time." }] };
  } };
  const out = await extractFromBuffer({ buffer: Buffer.from("%PDF-1.7"), kind: "pdf", firstPage: 7 }, { limits, pdf });
  assert.equal(out.last_page, 7, "the worker continues from page 8");
});

test("an encrypted PDF is a 422 with its own code; a non-PDF sent as pdf is a 415; a missing PDF reader is a 503", async () => {
  const locked = { extractPdfPages: async () => { throw Object.assign(new Error("No password given"), { name: "PasswordException" }); } };
  await assert.rejects(extractFromBuffer({ buffer: Buffer.from("%PDF-1.7"), kind: "pdf" }, { limits, pdf: locked }), (e) => e.status === 422 && e.code === "pdf_encrypted");
  const broken = { extractPdfPages: async () => { throw new Error("Invalid PDF structure"); } };
  await assert.rejects(extractFromBuffer({ buffer: Buffer.from("%PDF-1.7"), kind: "pdf" }, { limits, pdf: broken }), (e) => e.status === 422 && e.code === "pdf_unreadable");
  const missing = { extractPdfPages: async () => { throw Object.assign(new Error("PDF support isn't available"), { code: "pdf_unavailable" }); } };
  await assert.rejects(extractFromBuffer({ buffer: Buffer.from("%PDF-1.7"), kind: "pdf" }, { limits, pdf: missing }), (e) => e.status === 503);
  await assert.rejects(extractFromBuffer({ buffer: Buffer.from("<html></html>"), contentType: "text/html", kind: "pdf" }, { limits }), (e) => e.status === 415);
  await assert.rejects(extractFromBuffer({ buffer: Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), contentType: "application/msword", kind: "doc" }, { limits }), (e) => e.status === 415, "legacy .doc");
});

test("a web page becomes one page-less entry with its title; an empty one is no_text", async () => {
  const out = await extractFromBuffer({ buffer: Buffer.from("<title>Osmosis</title><p>Water moves across membranes toward higher solute concentration.</p>"), contentType: "text/html", kind: "link" }, { limits });
  assert.equal(out.format, "html");
  assert.equal(out.title, "Osmosis");
  assert.equal(out.pages.length, 1);
  assert.equal(out.pages[0].page, null);
  assert.equal(out.total_pages, null);
  await assert.rejects(extractFromBuffer({ buffer: Buffer.from("<p> </p>"), contentType: "text/html", kind: "link" }, { limits }), (e) => e.status === 422 && e.code === "no_text");
});

test("text is capped: a PDF window stops at the limit, a document or page over it is too large", async () => {
  const small = { ...limits, maxTextChars: 100 };
  const pdf = fakePdf(["a".repeat(60), "b".repeat(30), "c".repeat(30), "d".repeat(30)]);
  const out = await extractFromBuffer({ buffer: Buffer.from("%PDF-1.7"), kind: "pdf" }, { limits: small, pdf });
  assert.deepEqual([out.pages.map((p) => p.page), out.last_page, out.total_pages], [[1, 2], 2, 4], "the worker continues from page 3");
  await assert.rejects(extractFromBuffer({ buffer: Buffer.from("%PDF-1.7"), kind: "pdf" }, { limits: small, pdf: fakePdf(["x".repeat(101)]) }), (e) => e.status === 413 && e.code === "too_large");
  await assert.rejects(extractFromBuffer({ buffer: Buffer.from("<p>" + "word ".repeat(30) + "</p>"), contentType: "text/html", kind: "link" }, { limits: small }), (e) => e.status === 413 && e.code === "too_large");
});

test("the reader's own answers pass through: busy (503) and out of memory (413)", async () => {
  for (const [status, code] of [[503, "busy"], [413, "too_large"]]) {
    const err = () => Object.assign(new Error("x"), { status, code });
    await assert.rejects(extractFromBuffer({ buffer: Buffer.from("%PDF-1.7"), kind: "pdf" }, { limits, pdf: { extractPdfPages: async () => { throw err(); } } }), (e) => e.status === status && e.code === code);
    const loadMammoth = async () => ({ convertToHtml: async () => { throw err(); } });
    await assert.rejects(extractFromBuffer({ buffer: Buffer.from("PK\x03\x04"), contentType: "", kind: "doc" }, { limits, loadMammoth }), (e) => e.status === status && e.code === code);
  }
  // A read that ran out of time is unreadable, not a server error.
  const slow = { extractPdfPages: async () => { throw Object.assign(new Error("slow"), { code: "isolate_timeout" }); } };
  await assert.rejects(extractFromBuffer({ buffer: Buffer.from("%PDF-1.7"), kind: "pdf" }, { limits, pdf: slow }), (e) => e.status === 422 && e.code === "pdf_unreadable");
});

test("a docx goes through mammoth's HTML so headings become chunk titles", async () => {
  const loadMammoth = async () => ({ convertToHtml: async () => ({ value: "<h1>Week 2: Enzymes</h1><p>Enzymes lower activation energy.</p>" }) });
  const zip = Buffer.from("PK\x03\x04 fake docx");
  const out = await extractFromBuffer({ buffer: zip, contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kind: "doc" }, { limits, loadMammoth });
  assert.equal(out.format, "docx");
  assert.equal(out.pages[0].chunks[0].title, "Week 2: Enzymes");
  const failing = async () => ({ convertToHtml: async () => { throw new Error("bad zip"); } });
  await assert.rejects(extractFromBuffer({ buffer: zip, contentType: "", kind: "doc" }, { limits, loadMammoth: failing }), (e) => e.status === 422 && e.code === "doc_unreadable");
});

test("limits come from env, and a bad value falls back to the default", () => {
  assert.deepEqual(extractLimits({}), { maxBytes: 26214400, maxLinkBytes: 5242880, maxPages: 100, timeoutMs: 20000, budgetMs: 60000, minPageChars: 10, maxMemoryMb: 350, maxTextChars: 3000000 });
  const l = extractLimits({ EXTRACT_MAX_PAGES: "20", EXTRACT_TIMEOUT_MS: "abc", EXTRACT_MAX_BYTES: "-1" });
  assert.equal(l.maxPages, 20);
  assert.equal(l.timeoutMs, 20000);
  assert.equal(l.maxBytes, 26214400);
});

// ---- the scanned-page renderer ----

test("the renderer downloads from storage, renders only the requested pages, and checks they exist", async () => {
  const fetchImpl = async () => new Response("%PDF-1.7 fake", { status: 200 });
  const calls = [];
  const render = async (buf, pages, { width }) => { calls.push({ pages, width }); return pages.filter((p) => p <= 5).reverse().map((p) => ({ page: p, mediaType: "image/png", data: "AAAA" })); };
  const renderPages = makeRenderPdfPages({ env: { ...ENV, DUALREP_RENDER_WIDTH: "1200" }, fetchImpl, lookup: publicDns, render });
  const shots = await renderPages(PDF_URL, [2, 3]);
  assert.deepEqual(shots.map((s) => s.page), [2, 3], "in the requested order");
  assert.deepEqual(calls[0], { pages: [2, 3], width: 1200 });
  await assert.rejects(renderPages(PDF_URL, [5, 6]), (e) => e.status === 422 && e.code === "page_out_of_range");
  await assert.rejects(renderPages("https://evil.example/x.pdf", [1]), (e) => e.status === 400 && e.code === "bad_url");
  const notPdf = makeRenderPdfPages({ env: ENV, fetchImpl: async () => new Response("<html>"), lookup: publicDns, render });
  await assert.rejects(notPdf(PDF_URL, [1]), (e) => e.status === 415);
});

test("the renderer has its own time budget, passes busy on, and refuses an oversized result", async () => {
  const fetchImpl = async () => new Response("%PDF-1.7 fake", { status: 200 });
  let opts;
  const make = (render, env = ENV) => makeRenderPdfPages({ env, fetchImpl, lookup: publicDns, render });
  const t0 = Date.now();
  await make(async (buf, pages, o) => { opts = o; return pages.map((p) => ({ page: p, mediaType: "image/jpeg", data: "AAAA" })); }, { ...ENV, DUALREP_RENDER_BUDGET_MS: "30000" })(PDF_URL, [1]);
  assert.equal(opts.quality, 85);
  assert.ok(opts.deadline >= t0 + 30000 && opts.deadline <= Date.now() + 30000, "pages stop being rendered after the budget");
  // Out of time: a 503 the worker retries later (the model keeps its share of the task's time).
  for (const code of ["render_timeout", "isolate_timeout"]) {
    await assert.rejects(make(async () => { throw Object.assign(new Error("slow"), { code }); })(PDF_URL, [1]), (e) => e.status === 503 && e.code === "render_timeout");
  }
  await assert.rejects(make(async () => { throw Object.assign(new Error("busy"), { status: 503, code: "busy" }); })(PDF_URL, [1]), (e) => e.status === 503 && e.code === "busy");
  await assert.rejects(make(async () => { throw Object.assign(new Error("big"), { status: 413, code: "too_large" }); })(PDF_URL, [1]), (e) => e.status === 413);
  const huge = "A".repeat(7 * 1024 * 1024);
  await assert.rejects(make(async (buf, pages) => pages.map((p) => ({ page: p, mediaType: "image/jpeg", data: huge })))(PDF_URL, [1, 2, 3, 4]), (e) => e.status === 413 && e.code === "too_large");
});

test("a page too detailed to render here is page_too_large, not a file too large to read", async () => {
  const fetchImpl = async () => new Response("%PDF-1.7 fake", { status: 200 });
  const make = (render) => makeRenderPdfPages({ env: ENV, fetchImpl, lookup: publicDns, render });
  // The render child killed at its memory limit (a 600 dpi scan, a 24 MP photo page).
  await assert.rejects(
    make(async () => { throw Object.assign(new Error("the file needs too much memory to read"), { status: 413, code: "too_large" }); })(PDF_URL, [1, 2]),
    (e) => e.status === 413 && e.code === "page_too_large",
  );
  // One page image over the API's 10 MB per image: refused before the model is asked.
  const shot = (page, mb) => ({ page, mediaType: "image/jpeg", data: "A".repeat(mb * 1024 * 1024) });
  await assert.rejects(
    make(async () => [shot(1, 1), shot(2, 11)])(PDF_URL, [1, 2]),
    (e) => e.status === 413 && e.code === "page_too_large",
  );
});

// ---- real libraries (skipped without node_modules) ----

async function optional(name) {
  try { return (await import(name)).default; } catch { return null; }
}
const PDFDocument = await optional("pdfkit");
const docxLib = await import("docx").catch(() => null);
const pdfParse = await import("pdf-parse").catch(() => null);
const canRunReal = Boolean(PDFDocument && pdfParse);
const hasCanvas = Boolean(await import("@napi-rs/canvas").catch(() => null)); // pdf-parse renders pages with it

function makePdf() {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ autoFirstPage: false });
    const parts = [];
    doc.on("data", (d) => parts.push(d));
    doc.on("end", () => resolve(Buffer.concat(parts)));
    doc.on("error", reject);
    doc.addPage(); doc.fontSize(20).text("Chapter 1: Cells"); doc.moveDown(); doc.fontSize(11)
      .text("The cell is the basic unit of life. Mitochondria produce ATP.").moveDown()
      .text("Ribosomes synthesize proteins from mRNA templates.");
    doc.addPage(); doc.rect(50, 50, 400, 300).fill("#888"); // drawing only: no text layer, like a scan
    doc.addPage(); doc.fill("#000").fontSize(11).text("Photosynthesis converts light energy into chemical energy stored in glucose. ".repeat(30));
    doc.end();
  });
}

test("real pdf-parse: per-page text, a scanned-looking page, windows, and rendering", { skip: !canRunReal && "pdfkit/pdf-parse not installed" }, async () => {
  const pdf = await makePdf();
  const out = await extractFromBuffer({ buffer: pdf, contentType: "application/pdf", kind: "pdf" }, { limits });
  assert.equal(out.total_pages, 3);
  assert.deepEqual(out.pages.map((p) => [p.page, p.needs_transcription]), [[1, false], [2, true], [3, false]]);
  assert.match(out.pages[0].chunks[0].content, /Mitochondria produce ATP/);
  assert.ok(out.pages[2].chunks.length > 1 && out.pages[2].chunks.every((c) => c.content.length <= 1600));
  const win = await extractFromBuffer({ buffer: pdf, kind: "pdf", firstPage: 3 }, { limits });
  assert.deepEqual([win.first_page, win.last_page, win.pages.map((p) => p.page)], [3, 3, [3]]);
  const past = await extractFromBuffer({ buffer: pdf, kind: "pdf", firstPage: 9 }, { limits });
  assert.deepEqual([past.pages.length, past.total_pages], [0, 3]);
  const budget = await extractFromBuffer({ buffer: pdf, kind: "pdf" }, { limits: { ...limits, budgetMs: 1 }, now: () => Date.now() - 10 });
  assert.deepEqual(budget.pages.map((p) => p.page), [1], "an exhausted budget still reads one page");
  assert.equal(budget.last_page, 1);

  if (!hasCanvas) return; // no canvas on this host: text extraction is still verified above
  const renderPages = makeRenderPdfPages({ env: ENV, lookup: publicDns, fetchImpl: async () => new Response(pdf, { status: 200 }) });
  const rendered = await renderPages(PDF_URL, [3, 2]);
  assert.deepEqual(rendered.map((s) => [s.page, s.mediaType]), [[3, "image/jpeg"], [2, "image/jpeg"]]);
  assert.deepEqual([...Buffer.from(rendered[0].data, "base64").subarray(0, 3)], [0xff, 0xd8, 0xff], "a JPEG");
  const letter = jpegSize(rendered[0].data);
  assert.ok(Math.abs(letter.width - 1568) <= 1 && letter.height === 2029, "a letter page at 1568 px wide, as before");
});

// Width x height of a base64 JPEG, from its start-of-frame marker.
function jpegSize(base64) {
  const j = Buffer.from(base64, "base64");
  for (let i = 2; i + 9 < j.length;) {
    const marker = j[i + 1];
    if (marker >= 0xc0 && marker <= 0xc3) return { width: j.readUInt16BE(i + 7), height: j.readUInt16BE(i + 5) };
    i += 2 + j.readUInt16BE(i + 2);
  }
  return null;
}

test("real rendering: a very tall page is scaled to a 2576 px long edge, never past the API's 8000 px", { skip: !(canRunReal && hasCanvas) && "pdfkit, pdf-parse or the canvas not installed" }, async () => {
  // A continuous note export or a long receipt: 612 x 4000 pt, drawing only (no text layer).
  const pdf = await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ autoFirstPage: false });
    const parts = [];
    doc.on("data", (d) => parts.push(d));
    doc.on("end", () => resolve(Buffer.concat(parts)));
    doc.on("error", reject);
    doc.addPage({ size: [612, 4000] });
    for (let y = 40; y < 3960; y += 120) doc.rect(40, y, 500, 40).fill("#333");
    doc.end();
  });
  const renderPages = makeRenderPdfPages({ env: ENV, lookup: publicDns, fetchImpl: async () => new Response(pdf, { status: 200 }) });
  const [shot] = await renderPages(PDF_URL, [1]);
  const size = jpegSize(shot.data);
  assert.equal(size.height, 2576, `long edge capped (got ${size.width} x ${size.height}; width-only scaling gave 1568 x 10248)`);
  assert.ok(Math.abs(size.width - 394) <= 1, "the width keeps the page's proportions");
});

test("real rendering: garbage is collected before each full-resolution page image is drawn", { skip: !(canRunReal && hasCanvas) && "pdfkit, pdf-parse or the canvas not installed" }, async () => {
  // A picture-only page holding a 2400 x 2400 image (5.8 MP), like a scan. pdf.js draws it at full
  // size before scaling; collecting the decoder's garbage first keeps the peak the same every time.
  const { createCanvas } = await import("@napi-rs/canvas");
  const canvas = createCanvas(2400, 2400);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, 2400, 2400); ctx.fillStyle = "#000";
  for (let y = 60; y < 2400; y += 80) ctx.fillRect(100, y, 2200, 20);
  const png = canvas.encodeSync("png");
  const pdf = await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ autoFirstPage: false });
    const parts = [];
    doc.on("data", (d) => parts.push(d));
    doc.on("end", () => resolve(Buffer.concat(parts)));
    doc.on("error", reject);
    doc.addPage({ size: [612, 792], margin: 0 });
    doc.image(png, 0, 0, { width: 612 });
    doc.end();
  });
  const { renderPdfPagesJpeg } = await import("../src/pdf.js");
  const had = globalThis.gc;
  let collections = 0;
  globalThis.gc = () => { collections += 1; };
  try {
    const [shot] = await renderPdfPagesJpeg(pdf, [1]);
    assert.ok(shot.data.length > 0);
  } finally {
    if (had) globalThis.gc = had; else delete globalThis.gc;
  }
  assert.ok(collections >= 1, "collected before the 5.8 MP image canvas");
});

// A PDF whose one page content stream is tiny compressed and huge inflated.
function pdfBomb(mb) {
  const content = Buffer.alloc(mb * 1024 * 1024, 0x20);
  content.write("BT /F1 12 Tf 72 720 Td (Hello) Tj ET\n", 0);
  const z = zlib.deflateSync(content, { level: 9 });
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const parts = [Buffer.from("%PDF-1.4\n")];
  const offsets = [];
  let pos = parts[0].length;
  objs.forEach((o, i) => {
    offsets.push(pos);
    const b = o === null
      ? Buffer.concat([Buffer.from(`${i + 1} 0 obj\n<< /Length ${z.length} /Filter /FlateDecode >>\nstream\n`), z, Buffer.from("\nendstream\nendobj\n")])
      : Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`);
    parts.push(b);
    pos += b.length;
  });
  parts.push(Buffer.from(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("") +
    `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`));
  return Buffer.concat(parts);
}

test("real pdf-parse: a small PDF that inflates past the memory limit is refused, and Tracy stays up", { skip: !(pdfParse && existsSync("/proc/self/status")) && "pdf-parse or /proc missing" }, async () => {
  const bomb = pdfBomb(150);
  assert.ok(bomb.length < 1024 * 1024, "well under a megabyte to download");
  await assert.rejects(extractFromBuffer({ buffer: bomb, contentType: "application/pdf", kind: "pdf" }, { limits: { ...limits, maxMemoryMb: 200 } }), (e) => e.status === 413 && e.code === "too_large");
  assert.ok(process.memoryUsage().rss < 400 * 1024 * 1024, "the bomb never inflated in this process");
});

test("real mammoth: a docx heading survives as the chunk title", { skip: !(docxLib && (await optional("mammoth"))) && "docx/mammoth not installed" }, async () => {
  const { Document, Packer, Paragraph, HeadingLevel } = docxLib;
  const d = new Document({ sections: [{ children: [
    new Paragraph({ text: "Week 2: Enzymes", heading: HeadingLevel.HEADING_1 }),
    new Paragraph("Enzymes lower activation energy."),
    new Paragraph("Competitive inhibitors bind the active site."),
  ] }] });
  const buffer = await Packer.toBuffer(d);
  const out = await extractFromBuffer({ buffer, contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kind: "doc" }, { limits });
  assert.equal(out.format, "docx");
  assert.equal(out.pages[0].chunks[0].title, "Week 2: Enzymes");
  assert.match(out.pages[0].chunks[0].content, /Competitive inhibitors bind the active site\./);
});

test("real mammoth: a .docx that inflates past the memory limit is refused", { skip: !((await optional("mammoth")) && existsSync("/proc/self/status")) && "mammoth or /proc missing" }, async () => {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  const head = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>`;
  zip.file("word/document.xml", Buffer.concat([Buffer.from(head), Buffer.alloc(80 * 1024 * 1024, 0x61), Buffer.from("</w:t></w:r></w:p></w:body></w:document>")]));
  const docx = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });
  assert.ok(docx.length < 1024 * 1024);
  await assert.rejects(extractFromBuffer({ buffer: docx, contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kind: "doc" }, { limits: { ...limits, maxMemoryMb: 200 } }), (e) => e.status === 413 && e.code === "too_large");
});
