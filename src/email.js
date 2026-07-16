// Email delivery — how Tracy reaches out (digests, alerts).
//
// Provider-agnostic over plain HTTPS (no SDK dependency). Set one provider's
// API key and a verified "from" address:
//   EMAIL_PROVIDER   resend | sendgrid   (default: resend)
//   EMAIL_API_KEY    the provider API key
//   EMAIL_FROM       verified sender, e.g. "Tracy <tracy@yourdomain.com>"
//
// Gated on EMAIL_API_KEY + EMAIL_FROM: if unset, emailConfigured() is false and
// nothing sends (callers no-op), so the app runs fine without email set up.

const PROVIDER = (process.env.EMAIL_PROVIDER || "resend").toLowerCase();
const KEY = process.env.EMAIL_API_KEY || "";
const FROM = process.env.EMAIL_FROM || "";

export function emailConfigured() {
  return Boolean(KEY && FROM);
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
}

// Send one email. { to, subject, text, html? }. Best-effort; returns {ok} or {error}.
export async function sendEmail({ to, subject, text, html }) {
  if (!emailConfigured()) return { error: "email-not-configured" };
  const recipients = Array.isArray(to) ? to : [to];
  try {
    if (PROVIDER === "sendgrid") {
      const res = await withTimeout(fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          personalizations: [{ to: recipients.map((email) => ({ email })) }],
          from: parseFrom(FROM),
          subject,
          content: [
            { type: "text/plain", value: text || "" },
            ...(html ? [{ type: "text/html", value: html }] : []),
          ],
        }),
      }), 20000);
      if (!res.ok) return { error: `sendgrid HTTP ${res.status}` };
      return { ok: true };
    }
    // default: Resend
    const res = await withTimeout(fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to: recipients, subject, text, ...(html ? { html } : {}) }),
    }), 20000);
    if (!res.ok) return { error: `resend HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}

// SendGrid wants {email, name?}; accept "Name <addr>" or a bare address.
function parseFrom(from) {
  const m = from.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  return m ? { email: m[2], name: m[1] || undefined } : { email: from.trim() };
}
