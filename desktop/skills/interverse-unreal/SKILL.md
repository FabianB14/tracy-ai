---
name: interverse-unreal
description: Building Unreal Engine games with the InterverseSDK plugin — subsystem/async-action patterns, Blueprint exposure, adding endpoints, and UE build/test commands. Use for any UE 5 task in an Interverse game or when changing platforms/unreal/InterverseSDK.
---

# Interverse × Unreal Engine

Read `interverse-platform` first for the platform contracts (custody,
View conversion, readability). This skill is the UE-specific layer.

## Plugin layout (platforms/unreal/InterverseSDK)

- `Public/InterverseSubsystem.h` + `Private/InterverseSubsystem*.cpp` — a
  `UGameInstanceSubsystem`; every platform call is a method taking params +
  a dynamic delegate. HTTP goes through the shared Client helpers with the
  `/api/` endpoint prefix.
- `Public/InterverseTypes.h` — USTRUCTs mirroring API JSON
  (`FInterverseAsset`, `FInterverseIntent`, ...). Keep field names in sync
  with the backend response keys.
- `Private/Parsers.cpp` — one `ParseX` per response type; all JSON→struct
  conversion lives here, never inline in callbacks.
- `Public/InterverseAsyncActions_*.h` — Blueprint async nodes (latent
  "Wait for..." style) built on the `UInterverseAsyncAction` base;
  delegates via `DECLARE_DYNAMIC_DELEGATE_TwoParams(..., bool, bSuccess,
  FType, Result)`.
- Feature gating: `EInterverseFeature` tiers — check the tier before
  calling gated endpoints and fail with a clear message, not a silent no-op.

## Adding a new platform capability (the pattern)

1. Struct(s) in `InterverseTypes.h` → 2. `ParseX` in `Parsers.cpp` →
3. Subsystem method (GET/POST via Client, `/api/` prefix) → 4. Async
action wrapping it → 5. Category `"Interverse|<Area>"` on the UFUNCTION so
Blueprint menus stay organized.

## Game-side integration rules

- Wallet linking: show the QR (`interverse://intent/<code>`) from a
  wallet-link intent; poll/await the intent status; NEVER prompt players
  for keys or addresses in-game.
- `ConvertAssetForGame` is a read-side preview (asset never moves). To
  bring an item into this game: transfer via the intent flow first, then
  convert-as-view to get display metadata, then map `model_id`/`anim_tags`
  through the game's interchange table to native assets.
- Mint with `player_ref`, readable metadata, and an `image_uri`.

## Build & verify (agent-runnable)

- Compile check without the editor:
  `"$UE_ROOT/Engine/Build/BatchFiles/RunUAT.(sh|bat)" BuildPlugin
  -Plugin="<abs>/InterverseSDK.uplugin" -Package=<tmp> -TargetPlatforms=<host>`
- In a game project: `Build.(sh|bat) <Project>Editor <Platform>
  Development -Project=<uproject> -WaitMutex` (UBT), then
  `<UnrealEditor-Cmd> <uproject> -ExecCmds="Automation RunTests
  Interverse; Quit" -nullrhi -unattended -log` for automation tests.
- No UE on this machine? Say so and hand the human the exact command —
  never claim the plugin compiles untested.

## What agents should NOT attempt

Editor-only work: Blueprint graph editing, level/scene layout, materials,
rigging. Deliver C++ + Blueprint-callable APIs and tell the human exactly
which nodes to place. `.uasset`/`.umap` are binary — never hand-edit or
resolve merge conflicts in them; regenerate from the editor instead.
