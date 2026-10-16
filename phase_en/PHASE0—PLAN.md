# Phase 0: Desktop Pet Foundation Plan

## Goal

Establish a launchable, developable, and extensible Windows desktop application skeleton that provides a stable host for future character, chat, and Agent capabilities.

## Scope and Boundaries

- Use Tauri 2 as the desktop shell, with TypeScript and React or Vue on the frontend (choose one during initialization and record the decision).
- Implement a transparent, borderless, always-on-top window, together with basic dragging and window lifecycle management.
- Provide a minimum UI skeleton containing a desktop pet display area, chat area, and settings entry.
- Do not integrate a real LLM, database, voice, tool calling, or Live2D at this stage.

## Prerequisites and Dependencies

- A Windows development environment, Node.js LTS, a package manager, Rust stable, and the Tauri CLI.
- Confirm the application identifier, default window size, minimum window size, and development/production build commands.
- Communication between the frontend and Rust must use explicitly named Tauri commands or events.

## Implementation Tasks

1. Initialize the directory structure: `frontend/`, `backend/`, `database/`, `src-tauri/`, and `docs/`, and add a basic README.
2. Create a Tauri 2 application and configure the development server, production build, application name, and Windows packaging parameters.
3. Configure transparency, borderless mode, always-on-top behavior, hidden taskbar icon (if supported by the platform), and reasonable window security policies.
4. Implement basic commands for dragging, showing/hiding, exiting, and minimizing the window, with a unified error format.
5. Implement the application layout: a desktop pet placeholder area, expandable chat panel, settings placeholder page, and loading/error states.
6. Add TypeScript lint, format, and type-check commands, as well as Rust fmt/clippy commands.
7. Add minimum CI checks to ensure that frontend builds and Rust checks can be repeated reliably.

## Suggested Interfaces

- `window:show`, `window:hide`, `window:toggle`, `window:close`: window control events.
- `window:drag`: a drag command triggered by the frontend; parameters contain only validated window context.
- `app:get_info`: returns the version, runtime environment, and feature flags, but no sensitive paths or keys.
- Frontend components access the Tauri API through `WindowService`; platform calls should not be scattered across business components.

## Phase Deliverables

- A transparent, borderless desktop pet window that can start on Windows.
- Basic window interactions for dragging, showing/hiding, and exiting.
- A UI skeleton with chat and settings placeholder pages.
- A technical decision record documenting the frontend framework, default window parameters, and Tauri configuration.
- Runnable development, build, and check commands.

## Acceptance Criteria

- After startup, the window is transparent, borderless, and always on top, and the desktop pet placeholder is visible.
- Dragging the window does not change the layout and causes no obvious flicker or focus issues.
- The chat panel and settings entry can be opened and closed, with clear feedback for empty and error states.
- Exit paths release frontend listeners and Rust resources without leaving a background process.
- In a clean environment, the installation, development, and build commands in the README complete successfully.

## Testing and Verification

- Rust: `cargo fmt --check`, `cargo clippy -- -D warnings`, and unit tests covering window command parameter validation.
- Frontend: type checking, linting, component rendering tests covering panel toggling and window service failure messages.
- Manual Windows tests: transparency, always-on-top behavior, dragging, exiting, multiple displays, and DPI scaling.
- Build tests: run both development and production builds once to confirm that resource paths are correct.

## Risks and Follow-Up Entry Points

- Transparent-window composition differences across Windows graphics drivers require validation on real devices.
- Window permissions and platform APIs must be encapsulated centrally to avoid later features depending directly on Tauri internals.
- Phase 1 can integrate assets and a state machine only after the desktop pet container is stable.

## Implementation Status

Completed in this repository: Tauri 2 project structure, React/Vite frontend, transparent borderless always-on-top window configuration, named window lifecycle and drag commands, pet/chat/settings UI skeleton, centralized window service, typed checks and formatting commands, CI workflow, and the Phase 0 technical decision record.

Still requires a real Windows manual verification: transparency, DPI scaling, multiple displays, drag focus behavior, and process cleanup after exit.

