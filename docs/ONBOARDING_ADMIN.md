# Onboarding a Worker to Tracy (Admin Access)

This guide walks you through giving a new team member **admin access** to Tracy —
the level that can pull business numbers (BabyResell stats, revenue, moderation,
shipping) on the **Admin** surface.

There are two roles in these steps:
- **You (the owner/operator)** — you have access to the Render dashboard.
- **The worker** — the person being onboarded. They only need a browser.

Admin access is protected by **two independent locks**, both of which must be
satisfied:
1. They must be on the **Admin surface** in the app.
2. Their **User ID** must be in the `ADMIN_USER_IDS` allowlist on the server.

This is deliberate: a normal user can never see business numbers, even if they
switch to the Admin surface, unless you've added their ID.

---

## Where things live

| Piece | Where |
|---|---|
| The app (what the worker opens) | Your Tracy URL — e.g. `https://tracy-ai.onrender.com` (or your Vercel URL) |
| The backend + settings | Render → the **tracy-ai** web service → **Environment** tab |
| The admin allowlist | Render env var **`ADMIN_USER_IDS`** |
| Access keys (if the site is gated) | Render env var **`ACCESS_KEYS`**, or generated with `scripts/genkey.js` |

---

## Step-by-step

### 1. (If the site is gated) give the worker an access key

If opening the app shows a **"key" gate** before the chat, you need to hand the
worker a key. Two ways:

- **Quick way — `ACCESS_KEYS` env var.** On Render, add or append a key to
  `ACCESS_KEYS` (comma-separated). Example:
  `ACCESS_KEYS=tracy-aaaa-bbbb,tracy-cccc-dddd`
- **Managed way — generate one.** From the repo:
  `node scripts/genkey.js "Jane — support"` — this creates a labeled, revocable
  key in the database and prints it once.

Send the worker their key over a secure channel. Each new browser they use will
ask for it once.

> If there's **no** key gate when you open the app, skip this step — the site is
> open and they can go straight in.

### 2. Worker opens the app and gets in

Send them the app URL. If prompted, they paste the access key from Step 1.

### 3. Worker copies their User ID and sends it to you

In the app, they click the **⚙ gear (Settings)** in the top bar and copy the
value in **User ID** (it looks like `web-9c754w3n`).

**This must be copied exactly** — it's unique to that browser. Have them paste it
to you character-for-character (copy/paste, don't retype).

> Each browser/device generates its own User ID. If the worker later switches
> devices or clears their browser, they'll get a new ID and you'll need to add
> the new one.

### 4. You add their User ID to the allowlist

On Render → **tracy-ai** service → **Environment** → edit **`ADMIN_USER_IDS`**:

- Add their ID to the existing list, **comma-separated**.
- Example for two admins: `web-9c754w3n,web-tulig60q`
- **No spaces instead of the comma, no quotes, no brackets, no line breaks.**
  Type it on one line. (A space or quote between IDs silently breaks the match
  for *everyone*.)

Save. Render **auto-deploys** on save — wait ~1 minute for it to go **Live**
(check the **Events / Deploys** tab).

### 5. Worker switches to the Admin surface and verifies

The worker sets the **surface dropdown** in the top bar (next to the 🔊 and ⚙
icons) to **Admin**, then asks:

> "How's BabyResell doing?"

If Tracy answers with real numbers, they're in. Done.

### 6. (Optional) Confirm with the diagnostic

Once the `/diag` endpoint is deployed, you can verify wiring precisely. Open:

```
https://tracy-ai.onrender.com/diag?userId=THEIR_USER_ID
```

- `adminUserIdsCount` — should equal the number of admins you've added.
- `userIdIsAdmin` — should be **true** for their ID.

If `userIdIsAdmin` is false while the count looks right, the ID doesn't match —
recheck Step 4 (format) and Step 3 (exact ID).

---

## Optional extras

### Let the worker use their own Anthropic key (BYOK)

If you want a worker's usage billed to **their** Anthropic account instead of the
shared key: in **Settings → Your Anthropic API key**, they paste their own
`sk-ant-...` key. It's stored only in their browser and used only for their
requests.

### Set up their daily check-in

The worker can just tell Tracy in chat:

> "Email me BabyResell's numbers every morning at 8."

Tracy will set it up and confirm. They can also say "what am I subscribed to?"
or "stop the daily email." (Requires email to be configured on the server.)

---

## Offboarding a worker

To remove admin access, do the reverse of Step 4:

1. Render → **tracy-ai** → **Environment** → edit **`ADMIN_USER_IDS`**.
2. Remove that worker's User ID (and the now-extra comma). Save → it redeploys.

If the site is gated and you want to cut off their access entirely, also revoke
their access key (remove it from `ACCESS_KEYS`, or revoke the generated key).

---

## Troubleshooting

**"Tracy says it's admin-only / I'm blocked."**
Their User ID isn't matching the allowlist. Check, in order:
1. Are they on the **Admin** surface? (Desktop/Mobile have no business tools.)
2. Is their ID in `ADMIN_USER_IDS`, spelled exactly, **comma-separated**, no
   quotes/spaces/brackets?
3. Did Render **redeploy** after you changed the var? (Events/Deploys tab.)

**"Adding a second admin broke it for the first one too."**
Classic separator bug — the two IDs aren't joined by a clean comma. Clear the
`ADMIN_USER_IDS` value and **retype** it by hand: `web-aaaa,web-bbbb`.

**"Tracy says she can't reach BabyResell / no live connection."**
That's a server-connection issue, not access. It means the BabyResell
credentials aren't set (`BABYRESELL_API_URL` + a key). Use `/diag` to see which
layer is missing.

---

## Quick reference — the env vars involved

| Var | Purpose |
|---|---|
| `ADMIN_USER_IDS` | Comma-separated User IDs allowed to use admin tools |
| `ACCESS_KEYS` | Comma-separated access keys (only if the site is gated) |
| `AUTH_SECRET` | When set, the site requires an access key |
| `BABYRESELL_API_URL` + a key | Connects Tracy to BabyResell's stats |

## The 60-second version

1. (If gated) give them an access key.
2. They open the app, go to **Settings → User ID**, send you that ID.
3. You add it to **`ADMIN_USER_IDS`** on Render (comma-separated), save.
4. They pick the **Admin** surface and ask "How's BabyResell doing?"
5. Numbers come back → they're an admin.
