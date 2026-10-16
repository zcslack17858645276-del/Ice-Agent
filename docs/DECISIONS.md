# Technical Decisions

## Phase 0 foundation

- Frontend: React 19 with TypeScript and Vite. React is familiar for the planned panel and state-machine UI, and Vite provides a small Tauri development server.
- Desktop shell: Tauri 2 with Rust. Platform calls are behind `frontend/windowService.ts`; components do not call Tauri APIs directly.
- Application identifier: `com.iceagent.desktop`.
- Window: 420 x 620 logical pixels, minimum 320 x 420, transparent, borderless, always on top, and hidden from the taskbar where Windows supports it.
- Security: Tauri isolation is enabled, CSP is set, and only the named window commands are exposed through the application invoke handler.
- Phase 0 intentionally has no LLM, database, voice, tool execution, or Live2D runtime integration.
