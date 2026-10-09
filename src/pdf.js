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

// PNG renders of the given pages, for vision transcription of scans.
// width: the rendered page width in px. 1568 keeps a portrait page (about
// 1568 x 2218) inside the 2576 px long edge Claude's high-resolution tier
// reads without downscaling. Pages past the end are skipped by pdf-parse.
export async function renderPdfPagesPng(buffer, pages, { width = 1568 } = {}) {
  const parser = await openPdf(buffer);
  try {
    const r = await parser.getScreenshot({ partial: pages, desiredWidth: width, imageDataUrl: false, imageBuffer: true });
    return (r.pages || []).map((p) => ({ page: p.pageNumber, mediaType: "image/png", data: Buffer.from(p.data).toString("base64") }));
  } finally {
    try { await parser.destroy(); } catch { /* ignore */ }
  }
}
