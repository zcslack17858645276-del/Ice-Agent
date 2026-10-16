# Technical Decisions

## Phase 0 foundation

- Frontend: React 19 with TypeScript and Vite. React is familiar for the planned panel and state-machine UI, and Vite provides a small Tauri development server.
- Desktop shell: Tauri 2 with Rust. Platform calls are behind `frontend/windowService.ts`; components do not call Tauri APIs directly.
- Application identifier: `com.iceagent.desktop`.
- Window: 420 x 620 logical pixels, minimum 320 x 420, transparent, borderless, always on top, and hidden from the taskbar where Windows supports it.
- Security: Tauri isolation is enabled, CSP is set, and only the named window commands are exposed through the application invoke handler.
- Phase 0 intentionally has no LLM, database, voice, tool execution, or Live2D runtime integration.

## Phase 1 character system

- Avatar behavior lives in `frontend/avatar`; a versioned JSON manifest provides characters, state clips, resolution, and asset provenance. Components query the registry rather than infer state from filenames.
- The first renderer is a React adapter for static PNGs. State feedback uses CSS motion and expression filters; the renderer contract accepts a future implementation without selecting a Live2D/3D SDK.
- Character selection and animation preference use versioned `localStorage` data. Selection, expression, and state remain independent.
- The repository supplies two transparent portraits (`assets/xglk4.png` and `assets/dny.png`) and the manifest marks them for personal use. The Live2D directory contains a complete model bundle and is validated by tests, but its SDK runtime is intentionally not loaded by this phase.
