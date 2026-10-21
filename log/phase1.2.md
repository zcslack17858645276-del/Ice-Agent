# Phase 1.2 Development Log

Historical record only. References below describe the retired Live2D integration; current avatar rendering uses static PNGs exclusively.

## Diagnosis

State transitions were already represented by `AvatarStateMachine`, but the Live2D renderer could mount while the asynchronous model catalog was still empty. That left it with an empty model URL and an invalid resource load during startup. Motion selection also assumed every mapped state group existed on every model, so a model without `Nod` or `Shake` could receive an unsupported motion request. The controller now uses the catalog's stable model URL immediately, keeps load generations cancellation-safe, and validates the available motion groups before selecting a state motion.

The default state is the existing `IDLE` snapshot. Unknown states continue to use the state-machine `IDLE` fallback. Missing model motion groups log a descriptive error and fall back to `Idle`, or leave the model static when no `Idle` group exists. No retry loop or blocking operation was introduced.

## Desktop interaction

- The pet window is configured as a transparent, frameless, always-on-top Tauri window. Frontend chrome is hidden in pet mode; its root and rendering stage fill the native viewport without an opaque fallback background or stage overflow.
- Left-button pointer-down on the character invokes the native drag command. Right-click is handled through `contextmenu` and does not invoke drag.
- The right-click menu exposes Chat, Move, States, Settings, and Exit. It is viewport-constrained and scrollable, and is shown only while requested.
- Chat and Settings open their own Tauri webview windows. Their preference changes synchronize with the pet window through browser storage events.

## Window bounds follow-up

- The original Tauri startup bounds were 420 x 620 logical pixels; startup bounds are now 280 x 360 logical pixels. The frontend root and Live2D canvas occupy that viewport without a CSS border, radius, shadow, or minimum-size overflow.
- Opening the context menu does not resize the pet window. Chat and Settings use separately sized native webview windows, so closing either panel leaves the pet window at its startup bounds and position.
- The model is aspect-fitted into the canvas using Cubism canvas metadata. Exact character margins and fit still require visual verification in the Windows WebView; the native window is not yet dynamically fitted to each model's animated bounds.

## Verification

```text
npm.cmd test
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build
npx.cmd prettier --check <changed files>
```

In this continuation, `npm.cmd test` passed (11 tests), `npm.cmd run typecheck`, `npm.cmd run build`, `npm.cmd run lint`, `cargo test`, `cargo fmt --check`, focused Prettier checks, and `git diff --check` passed. The workspace-wide Prettier check reports pre-existing formatting differences in `.tmp` profiles and `Ice-Agent Git Rules.md`, outside this task. Release builds were launched on Windows and visually confirmed to show the character without a title bar or rectangular window frame. The latest requested top-crop capture was obscured by other desktop windows, so the final crop appearance is not visually confirmed. Right-click/menu behavior, panel routing, motion transitions, transparent hit-testing, and DPI behavior still require direct Windows interaction testing.
