# Technical Decisions

## Phase 0 foundation

- Frontend: React 19 with TypeScript and Vite. React is familiar for the planned panel and state-machine UI, and Vite provides a small Tauri development server.
- Desktop shell: Tauri 2 with Rust. Platform calls are behind `frontend/windowService.ts`; components do not call Tauri APIs directly.
- Application identifier: `com.iceagent.desktop`.
- Window: 420 x 620 logical pixels, minimum 320 x 420, transparent, borderless, always on top, and hidden from the taskbar where Windows supports it.
- Security: Tauri isolation is enabled, CSP is set, and only the named window commands are exposed through the application invoke handler.
- Phase 0 intentionally has no LLM, database, voice, tool execution, or model runtime integration.

## Phase 1 character system

- Avatar behavior lives in `frontend/avatar`; a versioned JSON manifest provides characters, state clips, resolution, and asset provenance. Components query the registry rather than infer state from filenames.
- The renderer is a React adapter for static PNGs. State feedback uses CSS motion and expression filters.
- Character selection and animation preference use versioned `localStorage` data. Selection, expression, and state remain independent.
- The repository supplies two transparent portraits (`assets/xglk4.png` and `assets/dny.png`) and the manifest marks them for personal use. Static PNG rendering is the only implemented avatar path.

## Phase 3 memory system

- Memory contracts live under `frontend/memory`. SQLite schema and migration statements are versioned independently from the application, while `MemoryRepository` keeps storage replaceable for a native SQLite adapter.
- The current webview adapter is durable, schema-shaped local storage so core memory behavior remains testable offline. It validates writes, excludes sensitive candidates, keeps source-message references, and soft-deletes by default.
- Vector retrieval is optional and model-version scoped. `ContextAssembler` uses confirmed memories and recent messages, so vector or embedding failures do not interrupt short-term chat.
- Export is explicit JSON initiated by the settings panel and contains only structured memory/chat data; API credentials are never part of the repository export.

## Phase 4 voice interaction

- Voice capture, device enumeration, and playback use browser `MediaDevices` and Web Audio behind `frontend/voice` provider interfaces; the desktop shell remains responsible for protected remote credentials and network adapters.
- The first interaction mode is push-to-talk with explicit start/stop. TTS is queued by sentence or segment, and interim ASR remains optional.
- Whisper is an optional local ASR provider reached through a loopback-only Rust HTTP bridge. Its OpenAI-compatible transcription endpoint, model, and language are configured independently from the conversation provider; the default language is Chinese.
- The offline mock ASR and TTS providers remain available for deterministic tests. Whisper, GPT-SoVITS, and CosyVoice runtimes are not bundled; the WSL Whisper service must be started separately.
- Voice sessions use generation tokens so cancellation, new recordings, panel changes, and application shutdown cannot produce stale playback or overlapping audio.
- Raw recordings remain temporary by default. Voice settings are versioned in local storage, and the retention toggle defaults to disabled; enabling it is the only path that writes captured audio to app data.
- Persona settings are stored locally with a schema version and reset to the defaults in `trait/Trait.md`; each request records its Persona version so changing an open conversation does not rewrite history.
- GPT-SoVITS V2 is reached through the Rust bridge at loopback-only `/tts` with timeout and cancellation. The app never starts the WSL service and does not retain generated audio by default. Typed and push-to-talk replies share the same sentence playback queue.
