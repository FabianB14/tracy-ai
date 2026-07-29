# PartOut × Tracy — AI Mechanic on Tracy's shared repair brain

This wires **PartOut**'s "AI Mechanic" through **Tracy** instead of calling
Gemini directly from the browser. The result is what you asked for:

- **Memory first.** When someone asks about a repair, Tracy first checks what
  she already knows for that **year / make / model / part**. If she has it, she
  answers from memory — fast and consistent. If she doesn't, she works it out
  (Claude/Gemini) and **saves the answer back** to a shared knowledge base, so
  the next person asking that same repair gets it from memory. She gets better
  at car repair the more PartOut is used.
- **Guardrails always on.** The safety rules (jack stands, high-voltage/EV,
  fuel system, airbags/SRS, brakes/steering/suspension, hot/pressurized
  systems) live in Tracy's `carparts` surface prompt, so they apply to every
  answer automatically.
- **Vehicle-anchored.** PartOut already collects "Your vehicle" — that gets
  folded into each question so answers and saved memory are tied to the exact
  vehicle.

Nothing else in PartOut changes. The Mechanic UI, chat history, photo attach,
and the vehicle field all keep working. Only the one network call the Mechanic
makes is rerouted.

> The 🎨 **Draw a diagram** feature stays on Gemini image generation (Tracy
> doesn't generate images), so it keeps using the user's Gemini key. Only the
> text mechanic chat moves to Tracy. Nothing to do there.

## Cost model — hybrid (keeps bring-your-own-key)

PartOut users already add their own Gemini key (the 🔑 button). This integration
**keeps that** — it doesn't move the mechanic's cost onto your Tracy account:

- The drop-in automatically forwards the user's Gemini key (`po_api_key`) to
  Tracy as an `X-Gemini-Key` header.
- Tracy answers **Gemini-first on that key**, so the mechanic's generation bills
  the user, exactly like today.
- Tracy falls back to **her own Claude** only when Gemini can't (no key present,
  or a Gemini error) — so you pay only for the rare miss where a user has no key.
- Every fresh answer is saved to **shared memory**, so repeats come back with no
  AI call at all — free for everyone, no matter whose key first learned it.

Shared memory still works across different users' keys, because the embedding
vectors that power the memory depend only on the model (`text-embedding-004`),
not on whose key produced them. (Embeddings run on the **server's**
`GEMINI_API_KEY`, which Tracy needs anyway — see below.)

---

## What "Tracy" is here

Tracy's backend is already deployed at **`https://tracy-ai.onrender.com`**. The
Mechanic calls `POST /chat` with `surface: "carparts"`. That surface is built
for exactly this — see `prompts/surfaces/carparts.md` in the tracy-ai repo.

The shared repair memory (the knowledge base) is active whenever Tracy's server
has a `GEMINI_API_KEY` set (it's used for embeddings). Answers Tracy works out
on the `carparts` surface are saved **globally** (a 2015 Civic alternator R&R
is the same for everyone), so the memory is shared across all PartOut users.

---

## Integration (≈ 5 minutes)

### 1. Add the drop-in file

Copy `tracy-mechanic.js` (in this folder) into PartOut's web app next to
`app.js`:

```
partout/docs/tracy-mechanic.js
```

### 2. Load it before `app.js`

In `docs/index.html`, add the script **before** the existing `app.js`:

```html
<script src="tracy-mechanic.js"></script>
<script src="app.js"></script>
```

### 3. Point the Mechanic at Tracy

In `docs/app.js`, replace the **body** of `mechanicChat(history)` with a single
call. Find this function (it builds a Gemini request) and swap it for:

```js
async function mechanicChat(history) {
  // Route the mechanic through Tracy's shared car-repair brain (memory-first +
  // safety guardrails). See tracy-mechanic.js.
  return TracyMechanic.chat(history);
}
```

That's it. `TracyMechanic.chat` takes the same `history` array PartOut already
passes and returns the reply string, so `sendChat()` is unchanged.

> Prefer even fewer edits? You can instead just **delete** PartOut's local
> `mechanicChat` — `tracy-mechanic.js` defines a global `mechanicChat` as a
> fallback when none exists. Replacing the body (above) is clearer, though.

---

## Configuration (localStorage keys)

`tracy-mechanic.js` reads a few optional keys from `localStorage`. Defaults are
sensible; set these only if you need to.

| Key           | Default                          | Purpose |
|---------------|----------------------------------|---------|
| `tracy_base`  | `https://tracy-ai.onrender.com`  | Tracy backend URL (point at a staging server if you want). |
| `tracy_user`  | auto-generated `partout-xxxx`    | Stable per-device id for attribution. Set it to a known worker id to unify a person across devices. |
| `tracy_key`   | *(none)*                         | Tracy access key — only needed if the backend has the access gate on (`AUTH_SECRET`). Redeemed once for a token. |
| `po_api_key`  | *(PartOut's 🔑 button)*          | The user's Gemini key. Already set by PartOut; the drop-in forwards it to Tracy automatically so the mechanic bills the user's key. |

---

## Two things to check on Tracy's server

1. **CORS.** Tracy allows all origins unless `CORS_ORIGINS` is set. If you've
   locked it down, add PartOut's origin (e.g. its GitHub Pages / hosting URL)
   to `CORS_ORIGINS` on Render so the browser can call `/chat`.

2. **Access gate.** If Tracy's `AUTH_SECRET` is set, PartOut needs a key: set
   `localStorage['tracy_key']` to a valid access key (generate one with
   `node scripts/genkey.js "PartOut"`). If the gate is off, no key is needed.

---

## Verify it works

1. Open PartOut, go to the **Mechanic** tab, set a vehicle (e.g.
   `2015 Honda Civic 1.8L`), and ask a repair question.
2. First ask: Tracy works it out and saves it. Ask the *same* repair again
   (even from another device) — it should come back fast and consistent.
3. Watch Tracy's learning grow: `GET https://tracy-ai.onrender.com/kb/stats`
   returns how often she answers from her own memory vs. asking Claude.

Photos attach too: the mechanic sends the user's photo to Tracy as an image, so
"what's this part / what's leaking here?" works with a picture.
