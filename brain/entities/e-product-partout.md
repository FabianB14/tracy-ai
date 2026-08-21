---
id: e-product-partout
type: product
title: PartOut
aliases: [Part Out, partout]
confidence: 1.0
last_verified: 2026-08-21
sources: [first-party]
links: [e-company-interverse, e-product-tracy, e-product-babyresell]
tracy_ready: true
---

## Summary

PartOut is Interverse's car app: point your camera at a car part and let AI do
the rest. Features: **Scan** (photo in; AI identifies the part, grades condition,
estimates used value, drafts a listing), **AI Mechanic** (repair chat anchored to
the user's exact vehicle, with photo attachments and generated instructional
diagrams), **Pull Guide** (step by step removal with fasteners marked on the
photo), **Garage Logs** (on-device scan history), and **Part-Outs** (salvage
pull lists with estimated payout).

Two builds: a PWA at fabianb14.github.io/PartOut (installable on Android and
iPhone) and a native Android app (Kotlin, Jetpack Compose). There is no PartOut
backend; user data stays on the device. AI runs on Gemini (gemini-2.5-flash for
text, flash-image for diagrams) using each user's own free Gemini API key, so
AI usage bills the user, not Interverse.

The AI Mechanic routes through [[e-product-tracy]]'s carparts surface: repair
questions check Tracy's shared repair knowledge base first (keyed by year, make,
model, part), answer Gemini-first on the user's key on a miss, fall back to
Claude only when needed, and save every fresh fix back for all users. Safety
guardrails (jack stands, high voltage, fuel, airbags, brakes) apply to every
answer. Business-model-wise it follows the [[e-product-babyresell]] vertical
marketplace template.

## Key facts

- Bring-your-own-key cost model: users supply their own Gemini key. [first-party]
- No backend; scans, chat, and garage data live on-device. [first-party]
- Mechanic is integrated with Tracy's shared repair memory and guardrails. [first-party]

## The play

PartOut is the second proof of the vertical playbook and the test bed for
AI-native supply creation: photo-to-listing lowers listing friction to near
zero. The junkyard partnership concept ([[c-partout-junkyard-partnerships]])
extends this from consumers to yards, making PartOut the search layer for
salvage inventory.
