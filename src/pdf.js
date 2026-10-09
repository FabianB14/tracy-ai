// PDF text extraction (server-side) — so uploaded repair manuals / documents
// become knowledge Tracy can retrieve. Uses pdf-parse (pdf.js under the hood).
//
// IMPORTANT: pdf-parse is imported LAZILY, on first actual PDF upload — never
// at startup. pdf.js crashes at import time on runtimes without DOM/canvas
// polyfills (e.g. Vercel serverless: "ReferenceError: DOMMatrix is not
// defined"), and a top-level import took the whole server down with it. The
// lazy pattern matches src/gemini.js: a host that can't load the package just
// can't extract PDFs — everything else keeps working.

let _pdfModule = null;
async function getPDFParse() {
  if (!_pdfModule) {
    _pdfModule = import("pdf-parse").catch((err) => {
      _pdfModule = null; // allow a retry; don't cache the failure forever
      // The code lets /ai/extract answer 503 (our problem) instead of
      // blaming the caller's file; the message is unchanged for /kb/upload.
      throw Object.assign(new Error(`PDF support isn't available on this server (${err.message}). Upload the document as .md or .txt instead.`), { code: "pdf_unavailable" });
    });
  }
  const { PDFParse } = await _pdfModule;
  return PDFParse;
}

export async function extractPdfText(buffer) {
  const PDFParse = await getPDFParse();
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const r = await parser.getText();
    let text = (r && r.text) || "";
    text = text.replace(/\n?-- \d+ of \d+ --\n?/g, "\n\n"); // drop page markers
    return text.trim();
  } finally {
    try { await parser.destroy(); } catch { /* ignore */ }
  }
}

// ---- Per-page access (DualRep's /ai/extract and scanned-page transcription) ----
// Untrusted PDFs: never let pdf.js evaluate font code (belt and braces; the
// installed pdf.js already has the CVE-2024-4367 fix).
async function openPdf(buffer) {
  const PDFParse = await getPDFParse();
  return new PDFParse({ data: new Uint8Array(buffer), isEvalSupported: false });
}

// Text of each page in [first, last], keeping page numbers (extractPdfText
// above joins them and drops the markers). Returns { total, pages: [{ num, text }] }.
// A page past the end is simply absent. Pages are read one at a time so a
// slow host can stop at `deadline` (a Date.now() value) and return what it
// has; at least one page is always read, so a caller paging through with
// first = last read + 1 always moves forward.
export async function extractPdfPages(buffer, { first = 1, last, deadline = Infinity } = {}) {
  const parser = await openPdf(buffer);
  try {
    const pages = [];
    let total = null;
    for (let n = first; total === null || n <= Math.min(last ?? total, total); n++) {
      // Both first and last set = an inclusive range in pdf-parse 2.x (first
      // alone would mean "the first N pages").
      const r = await parser.getText({ first: n, last: n, pageJoiner: "" });
      total = r.total;
      for (const p of r.pages || []) pages.push({ num: p.num, text: p.text || "" });
      if (Date.now() >= deadline) break;
    }
    return { total, pages };
  } finally {
    try { await parser.destroy(); } catch { /* ignore */ }
  }
}

// JPEG renders of the given pages, for vision transcription of scans
// (DualRep). Pages are rendered one at a time and each canvas is freed before
// the next, so a 4-page call holds one page bitmap instead of four; and JPEG
// (quality 85), because a scanned page as PNG costs about a second of CPU and
// 6-8 MB, as JPEG well under a tenth of a second and a few hundred KB, which
// keeps the request far under the API's 32 MB. width: 1568 keeps a portrait
// page (about 1568 x 2218) inside the 2576 px long edge Claude's
// high-resolution tier reads without downscaling. Pages past the end are
// skipped. `deadline` (a Date.now() value) is checked between pages: past it
// the render stops with code render_timeout, so the model call keeps its
// share of the task's time budget.
export async function renderPdfPagesJpeg(buffer, pages, { width = 1568, quality = 85, deadline = Infinity } = {}) {
  const parser = await openPdf(buffer);
  try {
    const doc = await parser.load();
    const out = [];
    for (const n of pages) {
      if (!Number.isInteger(n) || n < 1 || n > doc.numPages) continue;
      if (Date.now() >= deadline) throw Object.assign(new Error("rendering ran out of time"), { code: "render_timeout" });
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
      const factory = doc.canvasFactory;
      const target = factory.create(viewport.width, viewport.height);
      try {
        await page.render({ canvasContext: target.context, viewport, canvas: target.canvas }).promise;
        // encode() runs off the JavaScript thread (@napi-rs/canvas).
        const jpeg = await target.canvas.encode("jpeg", quality);
        out.push({ page: n, mediaType: "image/jpeg", data: Buffer.from(jpeg).toString("base64") });
      } finally {
        factory.destroy(target);
        page.cleanup();
      }
    }
    return out;
  } finally {
    try { await parser.destroy(); } catch { /* ignore */ }
  }
}
