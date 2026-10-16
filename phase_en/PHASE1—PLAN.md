# Phase 1: Character System Plan

## Goal

Give the desktop pet replaceable visual assets, basic animations, expressions, and observable life states.

## Scope and Boundaries

- Initially support PNG/WebP sequences or static assets, with an abstract asset interface for future Live2D or 3D integration.（png: assets/xglk.png，live2d: assets/live2d）
- Define the `IDLE`, `THINKING`, `HAPPY`, `SAD`, `WORKING`, and `SLEEPING` states.
- Implement state transitions, animation playback, expression switching, and fallback behavior for asset-loading failures.
- Do not implement model inference, emotion analysis, or lip synchronization in this phase.

## Prerequisites and Dependencies

- The desktop pet display area and lifecycle events from Phase 0 are available.
- Define the asset directory, naming rules, copyright/license records, and default character.
- Define the event contract between UI states and AI/voice states.

## Implementation Tasks

1. Define the `AvatarAsset`, `AnimationClip`, `AvatarExpression`, and `PetState` types.
2. Implement an asset registry that can find assets by character, state, expression, and resolution.
3. Implement the state machine: state entry, dwell, exit, priority, repeated-transition suppression, and unknown-state fallback.
4. Implement an animation controller supporting playback, pause, looping, one-shot animations, and asset preloading.
5. Bind the state machine to the desktop pet component, providing loading, missing-asset, and degraded-static-image states.
6. Add character selection and an animation toggle to the settings page; initially retain a local persistence implementation for the configuration interface.
7. Define the `AvatarRenderer` adapter boundary for future Live2D/3D support without coupling to a specific SDK in advance.

## Suggested Interfaces

- `AvatarRenderer.render(state, expression, asset)`: the renderer is responsible only for display.
- `AvatarStateMachine.transition(event)`: returns the current state, target state, and transition reason.
- `avatar:set_state`, `avatar:set_expression`, `avatar:preload`: use unified event names and parameter validation.
- Use versioned JSON for asset manifests; components must not infer business states from filenames.

## State Rules

- Temporary states such as `THINKING` and `WORKING` return to the most recent stable state when finished.
- `SLEEPING` may be triggered only by an explicit idle/time policy, never by a single rendering error.
- High-priority feedback animations may interrupt looping animations but must restore the previous state.
- When asset loading fails, use a default static asset and record a diagnosable error.

## Phase Deliverables

- At least one working character with visible feedback for every basic state.
- A replaceable asset manifest and asset directory convention.
- A testable state machine and renderer adapter interface.
- Character selection, animation toggle, and error messages in the settings page.

## Acceptance Criteria

- State transitions drive the corresponding animation or static presentation without animation buildup from repeated events.
- Missing or corrupted assets do not crash the application; the desktop pet continues to display a fallback asset.
- After switching characters, the state machine, preloading, and current expression remain consistent.
- Every state has observable entry and exit behavior, and debug logs include the state, reason, and time.

## Testing and Verification

- State machine unit tests: valid transitions, invalid transitions, priority, interruption/recovery, and unknown states.
- Component tests: asset loading, fallback display, animation toggle, and character switching.
- Manual tests: transparent window background, animation frame rate, DPI scaling, and long-running loops.
- Asset checks: manifest references exist, formats are decodable, and license information is complete.

## Risks and Follow-Up Entry Points

- Animation asset size and preloading may affect startup time; record asset sizes and load duration.
- Event names must remain stable because Phases 2, 4, and 5 will reuse them.
- Live2D/3D integration should add a renderer implementation without changing the public state-machine contract.

