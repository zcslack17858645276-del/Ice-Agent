# Phase 1.1 — Live2D Runtime Integration

## Objective

Integrate the existing Live2D Cubism model into Ice-Agent and
make it actually render and run as a desktop pet character.

This phase is an extension of Phase 1 and only covers the
Live2D runtime foundation.

Do not implement features belonging to later phases.

---

## 1. Existing Live2D Assets

The project already contains a complete Live2D model.

The existing model includes:

- `.model3.json`
- `.moc3`
- `.physics3.json`
- multiple `.motion3.json`
- `.cdi3.json`
- `.cmo3`
- `.can3`
- `.psd2live.json`
- corresponding texture resources

Main runtime entry:

`seethrough_output_1.model3.json`

The model resources have already been checked.

Do NOT recreate, replace, or simplify the existing Live2D model.

Do NOT treat texture files or `.motion3.json` files as
independent characters.

---

## 2. Current Problem

The Live2D model resources exist, but Ice-Agent currently lacks
the Live2D Runtime integration required to render them.

The missing capability is the runtime layer, including the
appropriate:

- Live2D Cubism Core runtime
- Live2D Cubism Framework/runtime code
- model loading
- rendering
- motion handling
- physics handling

Determine the appropriate runtime implementation for the existing
Tauri 2 + Vite + TypeScript architecture.

Prefer the Web / TypeScript / WebGL / WASM approach when
appropriate for the current frontend architecture.

Do not introduce a native Rust/C++ rendering architecture unless
the existing project clearly requires it.

---

## 3. Scope

Implement only the following:

### Runtime

- Initialize the Live2D Runtime.
- Load `seethrough_output_1.model3.json`.
- Load the referenced `.moc3`.
- Load the required textures.
- Load `physics3.json` when valid.
- Load the available `.motion3.json` files.

### Rendering

- Render the Live2D model in the existing desktop pet window.
- Preserve the existing transparent background.
- Preserve the existing frameless and always-on-top window.
- Preserve the existing UI structure.

### Animation

Provide a minimal character animation interface.

It should support operations equivalent to:

- load model
- play motion
- stop motion
- set expression
- set parameter
- set character state

Use the existing project architecture and naming conventions
where possible.

### Basic State Mapping

Connect the existing Phase 1 character states to Live2D motions
where appropriate.

For example:

`IDLE → idle motion`

Other states may be mapped only if suitable existing motions
are available.

Do not create a complex emotion system in this phase.

---

## 4. Explicitly Out of Scope

Do NOT implement:

- LLM integration
- long-term memory
- ASR
- TTS
- lip synchronization
- tool calling
- MCP
- proactive behavior
- emotion recognition
- automatic reminders
- multi-character switching
- second-character support

A second character is NOT required for Phase 1.1 validation.

---

## 5. Architecture Requirement

Keep the Live2D implementation isolated behind a character
control layer.

Conceptually:

Character State
      ↓
Character Controller
      ↓
Live2D Runtime
      ↓
Live2D Model

Future phases should be able to control the character through
the character control layer instead of directly accessing
Live2D Runtime internals.

Do not over-engineer this abstraction.

Implement only the minimum clean interface required for future
integration.

---

## 6. Validation

Perform actual runtime validation.

The following must be verified:

- Ice-Agent starts successfully.
- Live2D Runtime initializes successfully.
- `seethrough_output_1.model3.json` loads successfully.
- `.moc3` loads successfully.
- textures load successfully.
- the model is visibly rendered.
- at least one existing `.motion3.json` plays correctly.
- `physics3.json` initializes correctly if valid.
- the transparent desktop-pet window still works.
- the existing chat functionality still works.

Do not consider compilation alone sufficient validation.

If any item cannot be verified, clearly report the reason.

---

## 7. Resource and Dependency Handling

Before modifying the project:

1. Inspect the existing project structure.
2. Inspect `package.json`.
3. Inspect the existing frontend rendering architecture.
4. Determine which Live2D Runtime dependencies are actually
   required.

If additional Live2D Runtime files must be supplied manually,
report the exact:

- filename
- purpose
- expected location

Do not report only "Live2D SDK is missing".

Do not download or introduce unrelated SDK components.

---

## 8. Completion Criteria

Phase 1.1 is complete when:

> The existing Live2D character can be loaded through the
> Live2D Runtime, rendered inside Ice-Agent, and controlled
> through a basic character animation interface.

The phase does NOT require:

- multiple characters;
- AI-driven emotions;
- voice-driven animation;
- lip sync;
- autonomous behavior.

Those capabilities will be implemented by later phases.

---

## 9. Final Report

After implementation, provide a concise report containing:

1. Live2D Runtime / Framework used.
2. Dependencies added.
3. Runtime files added.
4. Model loading location.
5. Renderer implementation location.
6. Character control implementation location.
7. Motion/Physics verification result.
8. Whether existing chat functionality remains intact.
9. Remaining limitations.
10. Any files that must still be provided by the user.

Keep the implementation focused on Phase 1.1 only.

---

## Implementation Status

- [x] Live2D resource loader validates the supplied model, moc, texture, physics, and motion files.
- [x] Character control layer exposes model load, motion, stop, expression, parameter, and state operations.
- [x] Vite discovers `*.model3.json` entries in the designated custom model directories and serves their referenced assets from the public asset tree, preserving relative resource paths and transparent canvas rendering.
- [x] Static Phase 1 avatar fallback and existing chat UI remain available when the runtime is unavailable.
- [x] Cubism Core, Framework source integration, WebGL shader assets, and the project adapter are present. The XGLK and both Miku model entries validate, and the production build, full automated suite, typecheck, and lint pass. The built app starts in headless Edge and model/resource HTTP responses succeed. Visual motion playback, the physics effect, and Tauri WebView transparency remain unverified in a desktop session. The Chat panel remains a placeholder for a future phase. XGLK has no expression files; configured expressions on other models are loaded through the adapter.
