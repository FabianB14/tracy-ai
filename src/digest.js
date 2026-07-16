// Daily check-in digest — Tracy's summary of the apps a user subscribes to.
//
// Data-driven (no per-user model call), so it's cheap and reliable to run on a
// schedule. Each app has a builder that pulls its numbers and returns lines;
// buildDigest() stitches the requested apps into an email (subject/text/html).
//
// Add an app by adding an entry to APPS.

import { babyresellConfigured, getStats, getReportStats, getShippingBacklog } from "./babyresell.js";

const num = (n) => (n === null || n === undefined || isNaN(n)) ? "0" : Number(n).toLocaleString("en-US");
const money = (n) => "$" + num(Math.round(Number(n) || 0));

async function buildBabyresell() {
  if (!babyresellConfigured()) return { label: "BabyResell", note: "not connected yet" };
  try {
    const [stats, reports, shipping] = await Promise.all([
      getStats(),
      getReportStats().catch(() => null),
      getShippingBacklog().catch(() => null),
    ]);
    const g = stats.growth || {};
    const lines = [
      `${num(stats.totalUsers)} users (+${num(g.newUsers)} in the last 30 days)`,
      `${num(stats.totalItems)} listings — ${num(stats.activeItems)} active (+${num(g.newItems)} new)`,
      `${num(stats.totalTransactions)} transactions (+${num(g.newTransactions)})`,
      `${money(stats.totalRevenue)} in platform revenue`,
    ];
    if (reports && (reports.pending || reports.open)) {
      lines.push(`${num(reports.pending ?? reports.open)} report${(reports.pending ?? reports.open) === 1 ? "" : "s"} waiting on review`);
    }
    if (shipping && (shipping.needsLabel || shipping.failed)) {
      lines.push(`${num(shipping.needsLabel)} order(s) need a shipping label${shipping.failed ? `, ${num(shipping.failed)} label errors` : ""}`);
    }
    return { label: "BabyResell", lines };
  } catch (err) {
    return { label: "BabyResell", error: err.message };
  }
}

// Registry of apps a digest can cover. Extend here as new apps integrate.
export const APPS = {
  babyresell: { label: "BabyResell", build: buildBabyresell },
};

export function knownApps() {
  return Object.keys(APPS).map((key) => ({ key, label: APPS[key].label }));
}

function sectionHtml(label, lines) {
  return (
    `<div style="margin:0 0 18px">` +
    `<div style="font-weight:700;color:#0b1220;font-size:15px;margin-bottom:6px">${escape(label)}</div>` +
    `<ul style="margin:0;padding-left:18px;color:#334155;font-size:14px;line-height:1.6">` +
    lines.map((l) => `<li>${escape(l)}</li>`).join("") +
    `</ul></div>`
  );
}
function escape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Build the digest email for a set of app keys. Returns { subject, text, html }.
export async function buildDigest(apps) {
  const wanted = (apps || []).filter((a) => APPS[a]);
  const sections = [];
  for (const a of wanted) sections.push(await APPS[a].build());

  const date = new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
  const subject = `Tracy check-in — ${date}`;

  let text = `Hey! Here's your ${date} check-in.\n\n`;
  const htmlSections = [];
  for (const s of sections) {
    if (s.note) { text += `${s.label}: ${s.note}.\n\n`; htmlSections.push(sectionHtml(s.label, [s.note])); continue; }
    if (s.error) { text += `${s.label}: couldn't load its numbers right now.\n\n`; htmlSections.push(sectionHtml(s.label, ["couldn't load its numbers right now"])); continue; }
    text += `${s.label}:\n` + s.lines.map((l) => `  • ${l}`).join("\n") + "\n\n";
    htmlSections.push(sectionHtml(s.label, s.lines));
  }
  text += "— Tracy";

  const html =
    `<div style="max-width:560px;margin:0 auto;font-family:system-ui,-apple-system,Segoe UI,Arial,sans-serif;background:#fff;padding:24px">` +
    `<div style="font-weight:800;letter-spacing:2px;color:#0891b2;font-size:14px;margin-bottom:4px">TRACY</div>` +
    `<div style="color:#64748b;font-size:13px;margin-bottom:18px">Your ${escape(date)} check-in</div>` +
    htmlSections.join("") +
    `<div style="color:#94a3b8;font-size:12px;margin-top:8px;border-top:1px solid #e2e8f0;padding-top:12px">You're getting this because you turned on daily check-ins in Tracy. Turn it off anytime in Settings.</div>` +
    `</div>`;

  return { subject, text, html };
}
