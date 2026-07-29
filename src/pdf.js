// PDF text extraction (server-side) — so uploaded repair manuals / documents
// become knowledge Tracy can retrieve. Uses pdf-parse (pdf.js under the hood).

import { PDFParse } from "pdf-parse";

export async function extractPdfText(buffer) {
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
