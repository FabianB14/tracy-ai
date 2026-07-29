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
      throw new Error(`PDF support isn't available on this server (${err.message}). Upload the document as .md or .txt instead.`);
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
