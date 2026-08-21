---
id: e-product-babyresell
type: product
title: BabyResell
aliases: [Baby Resell, babyresell]
confidence: 1.0
last_verified: 2026-08-21
sources: [first-party]
links: [e-company-interverse]
tracy_ready: true
---

## Summary

BabyResell is Interverse Corp's live two-sided resale marketplace for baby and
children's items. Sellers list used gear, buyers purchase with integrated payments
and shipping. It is the company's flagship shipped product and the template for
future vertical marketplaces (PartOut for auto parts follows the same model).

Stack: React frontend, Node/Express backend, MongoDB Atlas, Firebase Auth,
Stripe payments, Shippo shipping, Cloudinary media, deployed on Render and Vercel.
Wrapped with Capacitor for Google Play distribution.

## Key facts

- Live in production with real payment and shipping rails. [first-party]
- Stack is Node/Express + MongoDB Atlas + Render/Vercel. It is NOT FastAPI,
  PostgreSQL, or DigitalOcean. This correction matters. [first-party]
- Android distribution via Capacitor wrapper on Google Play. [first-party]
- Serves as the architectural reference for PartOut. [first-party]

## The play

BabyResell is the proof that Interverse ships real products, and the reusable
foundation for every vertical marketplace after it. When evaluating new marketplace
ideas, the default question is: does the BabyResell architecture handle this with
a reskin plus one or two vertical-specific features? If yes, build cost is low and
the idea clears the bar faster.
