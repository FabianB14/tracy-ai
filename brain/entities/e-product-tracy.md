---
id: e-product-tracy
type: product
title: Tracy (Interverse AI assistant)
aliases: [Tracy, tracy-ai]
confidence: 1.0
last_verified: 2026-08-21
sources: [first-party]
links: [e-company-interverse, e-product-babyresell, e-product-partout]
tracy_ready: true
---

## Summary

Tracy is Interverse's AI assistant: one brain, many surfaces. A single core
identity runs everywhere (web, mobile PWA, and embedded in products), and each
surface layers on knowledge, behavior, and tools: Desktop, Mobile, Car Repair
(the [[e-product-partout]] Mechanic), Game Studios (SDK onboarding), New Hire,
Admin (live [[e-product-babyresell]] stats), BabyResell embed, and game:NAME
for any Interverse game.

She is a Claude assistant that delegates to Gemini as tools: live web research
with Google Search grounding, YouTube and media analysis, and cheap grounded
answers. Every message runs a confidence gate: check her own knowledge base
first, answer verbatim on a very strong match, answer via cheap Gemini on a
strong match, and only otherwise run the full Claude path. Fresh answers are
saved back, so she gets more self-sufficient with use, and a learning readout
shows the self-sufficiency percentage.

Voice in and out, per-user memory, document upload (md, txt, pdf) into the
knowledge base, conversational daily check-ins (email digest plus mobile push),
and an access gate with identity-bound personal keys. The vault passes secrets
between verified people: encrypted at rest, recipient-only retrieval, and
self-destruct on read by default. Frontend on Vercel, backend on Render with
Postgres.

## Key facts

- Stack: Node/Express, Anthropic SDK, Gemini via @google/genai, Postgres with
  file fallbacks. [first-party]
- Identity comes from access keys, not the editable User ID field. [first-party]
- This brain's entities/ folder is her curated knowledge source. [first-party]

## The play

Tracy is the intelligence layer every Interverse product inherits for the cost
of a surface prompt. New product, new surface, same brain, and everything she
learns in one surface compounds for the rest of the ecosystem.
