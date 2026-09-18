---
name: interverse-unity
description: Building Unity games with the Interverse SDK — InterverseManager patterns, coroutine API calls, serializable data types, and Unity batchmode build/test commands. Use for any Unity/C# task in an Interverse game or when changing platforms/unity.
---

# Interverse × Unity

Read `interverse-platform` first for the platform contracts (custody,
View conversion, readability). This skill is the Unity-specific layer.

## SDK layout (platforms/unity)

- `InterverseManager.cs` — the single MonoBehaviour entry point. Pattern:
  public method → `StartCoroutine` → `UnityWebRequest` (JSON body,
  `X-API-Key` header) → parse into a `[Serializable]` data class →
  `Action<bool, T>` callback. `IntentData` and friends mirror API JSON;
  keep field names matching response keys exactly (Unity's JsonUtility
  maps by name, no attributes).
- Add a capability by following an existing method end-to-end: data class
  → coroutine → public method with callback. No async/await — stay on
  coroutines for engine-version compatibility.

## Game-side integration rules

- Wallet linking: render the wallet-link QR (`interverse://intent/<code>`;
  any QR texture lib), then poll intent status. NEVER collect keys or
  addresses in a Unity input field.
- Conversion is a preview: call it to get restyled display metadata
  (`name`, `original_name`, mapped stats, `anim_tags`); the asset only
  enters this game through the player-intent transfer flow. Map
  `model_id`/`anim_tags` to prefabs/AnimationClips via a ScriptableObject
  interchange table, per `docs/ASSET-INTERCHANGE.md`.
- Mint with `player_ref`, readable metadata, and an `image_uri`. The API
  key belongs on the game's server or in server-authoritative code paths —
  a shipped client binary is not a secret store.

## Build & verify (agent-runnable)

- EditMode/PlayMode tests:
  `Unity -batchmode -nographics -projectPath <proj> -runTests
  -testPlatform EditMode -testResults <out>.xml -logFile - -quit`
- Script-compile check: `Unity -batchmode -nographics -projectPath <proj>
  -quit -logFile -` (non-zero exit or `error CS` lines = broken).
- No Unity on this machine? Say so and hand the human the exact command —
  never claim it compiles untested.

## What agents should NOT attempt

Scene layout, prefab wiring in the Inspector, animation controllers, art.
Deliver C# components with clear public fields and tell the human what to
drag where. Scene/prefab YAML merge conflicts: prefer regenerating in the
editor over hand-merging GUIDs.
