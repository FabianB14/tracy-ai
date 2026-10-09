// The child side of src/isolate.js: reads one document and exits. It gets
// { op, buffer, args } once over IPC and answers { ok, result } or
// { ok: false, error: { name, code, password } }: never an error message,
// which could quote the file. Its stdout and stderr go nowhere (see
// isolate.js), so nothing from the file reaches Tracy's logs.
//
//   pdfText    per-page text of a window (pdf.js extractPdfPages)
//   pdfRender  JPEG renders of scanned pages (pdf.js renderPdfPagesJpeg)
//   docxHtml   a .docx as HTML (mammoth), images left out: their bytes are
//              never read, and the text extraction drops <img> anyway

import { extractPdfPages, renderPdfPagesJpeg } from "./pdf.js";

async function docxHtml(buffer) {
  let mammoth;
  try {
    mammoth = (await import("mammoth")).default;
  } catch {
    throw Object.assign(new Error("mammoth is not installed"), { code: "doc_unavailable" });
  }
  const r = await mammoth.convertToHtml({ buffer }, { convertImage: mammoth.images.imgElement(() => ({ src: "" })) });
  return r.value;
}

const OPS = {
  pdfText: (buffer, args) => extractPdfPages(buffer, args),
  pdfRender: (buffer, args) => renderPdfPagesJpeg(buffer, args.pages, args),
  docxHtml: (buffer) => docxHtml(buffer),
};

process.once("message", async (msg) => {
  let reply;
  try {
    const op = Object.prototype.hasOwnProperty.call(OPS, msg?.op) ? OPS[msg.op] : null;
    if (!op) throw Object.assign(new Error("unknown op"), { code: "unknown_op" });
    const u8 = msg.buffer;
    const buffer = Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
    reply = { ok: true, result: await op(buffer, msg.args || {}) };
  } catch (err) {
    const name = typeof err?.name === "string" ? err.name : "Error";
    reply = {
      ok: false,
      error: {
        name: /^[\w.]{1,60}$/.test(name) ? name : "Error",
        code: typeof err?.code === "string" && /^[a-z_]{1,40}$/.test(err.code) ? err.code : null,
        password: /password/i.test(name) || /password/i.test(String(err?.message || "")),
      },
    };
  }
  process.send(reply, () => process.exit(0));
});
