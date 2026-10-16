# Phase 0 Development Log

## Date

2026-10-16

## Objective

Establish a launchable Tauri 2 desktop application foundation for the Ice Agent desktop pet. The phase scope covers the desktop window, a minimal frontend shell, named frontend-to-Rust commands, repeatable checks, and build documentation. LLM, database, voice, tool calling, and Live2D runtime integration remain outside this phase.

## Starting State

The repository contained the phase plans, project rules, and supplied asset files, but no application source tree or build configuration. The existing plan required `frontend/`, `backend/`, `database/`, `src-tauri/`, and `docs/` directories. The Phase 0 implementation uses `frontend/`, `src-tauri/`, and `docs/`; `backend/` and `database/` are reserved for later phases because Phase 0 has no backend service or database behavior.

## Implementation

### Project foundation

- Created the Vite and React TypeScript frontend structure.
- Added strict TypeScript configuration, ESLint, Prettier, npm scripts, and a lockfile.
- Added the Tauri 2 Rust crate, build script, application entry point, and configuration.
- Added the Windows application icon generated from the supplied asset.
- Added `.gitignore`, `.prettierignore`, and a Windows CI workflow.

### Desktop window

- Configured application identifier `com.iceagent.desktop`.
- Set the default window size to 420 x 620 logical pixels.
- Set the minimum window size to 320 x 420 logical pixels.
- Enabled transparency, borderless decorations, always-on-top behavior, centering, resizing, and taskbar suppression.
- Added a restrictive content security policy and exposed only the registered Tauri commands.

### Window command API

Added named commands in `src-tauri/src/lib.rs`:

- `window:show`
- `window:hide`
- `window:toggle`
- `window:close`
- `window:minimize`
- `window:drag`
- `app:get_info`

Commands return a unified serializable error type. The frontend calls them through `frontend/windowService.ts`, keeping Tauri APIs out of UI components.

### Frontend UI

Added a desktop pet placeholder with a compact title bar and toolbar. The UI includes:

- Pet display area with connection/loading state.
- Expandable chat panel with empty state and message input.
- Settings placeholder panel.
- Window controls and move action.
- User-visible error banner for failed window commands or application info loading.

## Verification

The following checks completed successfully:

```text
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run format
npm.cmd run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
npm.cmd run tauri build
```

The Rust test covers serialization and descriptive output for command errors. The production Tauri build generated both Windows packages:

- `src-tauri/target/release/bundle/nsis/Ice Agent_0.1.0_x64-setup.exe`
- `src-tauri/target/release/bundle/msi/Ice Agent_0.1.0_x64_en-US.msi`

## Issues Encountered and Resolved

1. Initial Rust dependency access was blocked by sandbox TLS credentials. The check was rerun with approved network access.
2. Tauri initially required a Windows icon. An `.ico` file was generated from the supplied PNG asset and added to the bundle configuration.
3. The package scripts initially referenced the Tauri CLI without declaring it. `@tauri-apps/cli` was added to the development dependencies.
4. The first bundle attempt could build the executable but could not download NSIS in the restricted environment. The bundle was rerun with approved network access.
5. WiX required an ICO path rather than the original PNG path. The configuration was corrected to use `src-tauri/icons/icon.ico`.

## Remaining Manual Verification

The following acceptance checks require a real Windows desktop session and were not claimed as automated results:

- Transparent composition across graphics drivers.
- Dragging behavior, focus behavior, and absence of visible flicker.
- Multiple display placement.
- DPI scaling at different Windows display scales.
- Exit cleanup and confirmation that no background process remains.

## Phase Result

The Phase 0 application foundation is implemented and has repeatable frontend, Rust, and Windows packaging checks. Later phases can add character assets and state behavior on top of the established window and UI boundaries.
