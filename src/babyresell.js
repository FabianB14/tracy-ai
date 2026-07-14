// BabyResell admin API client.
//
// Lets Tracy answer "how's BabyResell doing?" by calling BabyResell's own
// admin endpoints (https://babyresell-backend.onrender.com/api/admin/...).
//
// Config (env on Tracy's server — never committed):
//   BABYRESELL_API_URL         base URL, e.g. https://babyresell-backend.onrender.com
//   Auth, pick ONE:
//     A) BABYRESELL_JWT_SECRET + BABYRESELL_ADMIN_USER_ID
//        → Tracy mints a fresh short-lived admin JWT per request (durable; no
//          manual token refresh). Secret must match BabyResell's JWT_SECRET;
//          the user id is an admin user's Mongo _id.
//     B) BABYRESELL_ADMIN_TOKEN
//        → a Bearer token from an admin login, used as-is (simple, but expires).
//
// These are the user's own secrets for their own service; keep them in env only.

import crypto from "crypto";

const BASE = (process.env.BABYRESELL_API_URL || "").replace(/\/$/, "");
const ADMIN_TOKEN = process.env.BABYRESELL_ADMIN_TOKEN || "";
const JWT_SECRET = process.env.BABYRESELL_JWT_SECRET || "";
const ADMIN_USER_ID = process.env.BABYRESELL_ADMIN_USER_ID || "";

export function babyresellConfigured() {
  return Boolean(BASE) && (Boolean(ADMIN_TOKEN) || (Boolean(JWT_SECRET) && Boolean(ADMIN_USER_ID)));
}

// Mint a standard HS256 JWT ({ id, iat, exp }) that BabyResell's jwt.verify
// accepts (it does User.findById(decoded.id)).
function mintToken() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ id: ADMIN_USER_ID, iat: now, exp: now + 300 });
  const data = `${header}.${body}`;
  const sig = crypto.createHmac("sha256", JWT_SECRET).update(data).digest("base64url");
  return `${data}.${sig}`;
}

function authHeader() {
  if (JWT_SECRET && ADMIN_USER_ID) return "Bearer " + mintToken();
  if (ADMIN_TOKEN) return "Bearer " + ADMIN_TOKEN;
  return null;
}

async function apiGet(path) {
  const auth = authHeader();
  if (!BASE || !auth) throw new Error("not-configured");
  const res = await fetch(BASE + path, {
    headers: { Authorization: auth, "Content-Type": "application/json" },
  });
  if (res.status === 401 || res.status === 403) throw new Error("auth-failed");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return json && json.data !== undefined ? json.data : json;
}

export function getStats() { return apiGet("/api/admin/dashboard/stats"); }
export function getActivity(limit = 10) { return apiGet(`/api/admin/dashboard/activity?limit=${encodeURIComponent(limit)}`); }
