# Ice Agent: Desktop Interaction and State Switching

## Phase 1.2.1: Diagnose and Fix State Switching

Investigate why switching among the six states (`Idle`, `Thinking`, `Happy`, `Sad`, `Working`, and `Sleeping`) causes the characterto freeze.

Requirements:

1. Inspect the existing frontend, Tauri commands, Rust backend, Live2D integration, model resources, and state mappings before making changes.
2. Identify the actual root cause. Check for missing interfaces, invalid resource paths, failed resource loading, blocking operations, deadlocks, repeated model initialization, and duplicate animation loops.
3. Set `Idle` as the default state on application startup.
4. Verify that each state maps to a valid animation, expression, parameter update, or other supported model behavior.
5. If a state resource or animation is unavailable, log a descriptive error and fall back safely to `Idle`. Do not freeze the UI or retry indefinitely.
6. Keep state transitions asynchronous and non-blocking where appropriate.
7. Preserve the existing Cubism 5-r.5 integration and model-discovery implementation.
8. Test startup, all six states, repeated transitions, and recovery from invalid resources.
9. Report the root cause, modified files, validation results, and any remaining limitations.

Do not replace the existing Live2D implementation or rewrite unrelated modules.

## Phase 1.2.2: Borderless Desktop Pet Interaction

Modify the existing Tauri application to support a desktop-pet interaction model.

### Desktop Mode

- Display the character without a visible rectangular application frame.
- Preserve transparent window rendering and always-on-top behavior where appropriate.
- Support dragging the character by holding the left mouse button and moving the mouse.
- Avoid intercepting mouse input outside the intended interactive areas.

### Context Menu

- Open a compact menu with the right mouse button.
- Use an icon-and-text list layout.
- Provide entries for Chat, Move, States, Settings, and Exit, reusing existing functionality wherever possible.
- Ensure right-clicking does not accidentally trigger dragging or conflicting interactions.

### Panels and Transitions

- Open Chat and Settings panels only when requested.
- Implement smooth opening and closing transitions.
- Coordinate frontend animations with native Tauri window size, position, visibility, and transparency changes when necessary.
- Avoid flickering, unexpected window repositioning, and abrupt layout changes.
- Ensure all panels can be closed to return to the character-only desktop mode.

### Implementation Constraints

- Inspect the current architecture and existing project rules before editing.
- Reuse existing components and commands whenever possible.
- Do not introduce unnecessary dependencies or rewrite the application architecture.
- Keep changes incremental and testable.
- Do not claim a feature is implemented or verified unless it has actually been tested.

Implement Phase 1.2.1 first and report its results before proceeding to Phase 1.2.2.