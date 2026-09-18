---
name: tracy-dev
description: Developing Tracy, Interverse's AI assistant service — toolset/handler patterns, the KB-cache DYNAMIC_TOOLS rule, surface prompts, the machine lane, env wiring, and tests. Use for any change to the tracy-ai codebase.
---

# Tracy development

Tracy (Node/Express, ES modules) is Interverse's AI gateway: chat surfaces
for people AND the `/ai/tasks/:task` machine lane other services call. All
Interverse AI routes through Tracy — game clients and backends never call
model providers directly.

## Hard rules learned the hard way

1. **Every tool whose answer can change MUST be in `DYNAMIC_TOOLS`**
   (src/server.js). Replies produced without dynamic tools get cached in
   the knowledge base and replayed VERBATIM later — a status tool left off
   this list serves stale answers forever (this shipped as a real bug once).
2. **The Anthropic SDK is pinned** (`@anthropic-ai/sdk` ^0.32.0). No
   structured-outputs params — forced tool use is `tools` +
   `tool_choice: {type:"tool", name:...}`, and the JSON arrives as the
   tool call's input. Don't bump the pin as a side effect of a feature.
3. **Fail closed on service auth.** `/ai/tasks/:task` requires
   `X-Service-Secret` matching `SERVICE_SECRET` via timing-safe compare;
   unset secret = reject, never allow.
4. **Admin tools** are gated by `isAdminUser` (ADMIN_USER_IDS). Backend
   calls go through `interverseAdminFetch` (INTERVERSE_API_URL +
   INTERVERSE_ADMIN_KEY as `X-Admin-Key`). Never echo keys into replies.

## The patterns (src/tools.js)

- A capability area = a `...Schemas` array + a `...Handlers` object,
  registered in `toolSets`, referenced by a surface in src/surfaces.js.
- Handler signature `(input, context)`; return plain objects — `{error}` /
  `{note}` for failures, so the model can explain rather than crash.
- Backend writes that record an actor: send
  `updated_by: "tracy:" + (context.authUser?.userId || context.userId)`.
- Runtime switches on the backend go through `POST /admin/config`
  (`setRuntimeConfig` helper): `ai_conversion_enabled`,
  `test_kits_enabled` (booleans), `metadata_quality_enforce`
  (off|warn|reject).

## Surface prompts (prompts/surfaces/*.md)

`admin.md` is the operator surface. House style: lead with the answer, no
Markdown tables (replies are spoken/phone-rendered), codes and QR payloads
on their own copyable lines, flag-disabled features get the remedy stated.
When adding a tool, add its presentation guidance here too — the prompt is
half the feature.

## Verify before pushing

- `node --check src/<changed>.js` on every touched file.
- `node --test "tests/*.test.js"` (the glob is required on Node 22).
- `/diag?userId=<admin id>` reports wiring (env presence, livePing) —
  extend it when adding an integration, so deploy debugging stays cheap.

## Deploy notes

Render service `tracy`, branch `main`, auto-deploy. Env names matter
exactly: INTERVERSE_ADMIN_KEY (Tracy) pairs with ADMIN_REGISTRATION_KEY
(backend); TRACY_API_URL + TRACY_SERVICE_SECRET live on the backend side.
A wrong-name env var fails silent — check /diag, not vibes. Machine-lane
model comes from TRACY_TASK_MODEL.
