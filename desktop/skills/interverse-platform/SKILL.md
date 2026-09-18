---
name: interverse-platform
description: Interverse platform contracts for any agent writing game or backend code against the Interverse API — custody rules, the conversion-is-a-View decision, endpoints, mint metadata rules, and test kits. Use whenever a task touches Interverse assets, wallets, minting, transfers, conversion, or player linking.
---

# Interverse platform contracts

Interverse is a cross-game asset platform: items mint as NFTs on the
Interverse chain, travel between games with identity-preserving restyling,
and are owned by players through the Interverse Wallet. These contracts are
ratified decisions — never code around them.

## The two laws

1. **Custody (#17):** game code NEVER generates, stores, or uses player
   private keys. The player's wallet app is the only custody. A game learns
   a player's address through a signature-proven wallet-link intent (the
   player scans a QR code and signs). Game-side writes (mint, register,
   links, profiles) authenticate with the game's API key (`X-API-Key`).
2. **Conversion is a View (#18):** `POST /games/convert-asset` returns how
   an item renders in a target world (`preview: true`) and changes NOTHING.
   An asset's world changes ONLY through an owner-signed transfer (the
   player-intent/QR flow). Never write code that expects conversion to move
   an asset, and never reintroduce `ASSET_CONVERT` ledger writes.

Mental model for integrators: **transfer moves it, conversion renders it.**

## Core API surface (base: the game's INTERVERSE API URL, paths under /)

- `POST /nft/mint` — mint into a wallet. Use `player_ref` (the game's own
  player id) instead of a raw address once the player is linked; the
  backend resolves it. Requires `image_uri` (or generate flags) and
  READABLE metadata (see below).
- `GET /games/player-wallet/{player_ref}` — resolve a linked player.
- `POST /intents/wallet-link` / `POST /intents/transfer` — create one-time
  codes (`IVX-XXXX-XXXX`, QR payload `interverse://intent/<code>`). Codes
  are single-use and expire; the wallet app claims them with signatures.
- `POST /games/convert-asset` — the View. Body: `asset_id`,
  `target_game_id`. Caller must be the source or target game (403
  otherwise). Response: `metadata` (restyled name, mapped stats,
  `anim_tags`, `original_name`), `conversion_path` (`ai` | `rules` |
  `none`), `preview: true`, unchanged `game_id`.
- `POST /games/link` — register a game pair (catalog + static rules).
- `POST /games/conversion-profile` — register art style, stat keys,
  accepted categories, enforcement (`ai-only` | `block`; block → 409 on
  unaccepted categories).

## Mint metadata rules (the readability gate)

Mint-time metadata is scored deterministically (mode off/warn/reject,
default warn). To always pass: a human-readable `name` inside `metadata`,
readable stat keys (`damage`, not `p1`), no hex-blob values outside
allowlisted keys (`image_uri`, `asset_id`, ...), plus `category`, `rarity`,
and a `tags` list of readable words. Readable metadata is also what AI
conversion reasons over — treat it as a feature, not a chore. Details:
`docs/CONVERSION-READY.md`.

## Rendering converted items

Map shared vocabularies (`model_id`, `anim_tags`, `sockets`, `vfx`) to
native engine assets via a per-game mapping table; never expect engine
assets to travel. Contract: `docs/ASSET-INTERCHANGE.md`. Trading and
linking flows: `docs/PLAYER-WALLETS-AND-TRADING.md`.

## Test data

Never hand-craft test wallets. The backend provisions complete throwaway
rigs (games or your existing game ids + wallets WITH keys + pre-linked
players + live codes) via `POST /admin/testkit` — admin-key gated, behind
the `test_kits_enabled` runtime switch, everything expires ≤1h. Ask the
operator (Fabian/Josh) for a kit, or have them ask Tracy for one.

## Secrets hygiene for agents

- The game's `X-API-Key` lives in server config, never in client builds.
- Admin keys (`ADMIN_REGISTRATION_KEY` / `X-Admin-Key`) are operator-only:
  never embed them in game code, commit them, or echo them into chat.
- Test-kit private keys are throwaway BY DESIGN; production keys never
  appear anywhere outside the player's wallet app.
