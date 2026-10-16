# Phase 4: Voice Interaction System Plan

## Goal

Complete the voice-input-to-voice-output loop and provide consistent visual feedback while the desktop pet is recognizing, thinking, playing, or being interrupted.

## Scope and Boundaries

- Support replaceable providers for microphone capture, ASR, LLM, TTS, and audio playback.
- Initially support Whisper-style ASR and GPT-SoVITS or CosyVoice-style TTS adapters.
- Support push-to-talk or explicit recording start/stop; real-time streaming recognition is optional.
- Initially support volume/phoneme approximation for lip synchronization and do not promise professional-grade lip capture.

## Prerequisites and Dependencies

- Phase 1 state/animation interfaces, the Phase 2 LLM flow, and Phase 3 context strategy are available.
- Define microphone permissions, sample rate, audio format, cache location, and recording-retention policy.
- Prepare mock ASR/TTS providers so testing remains possible without local models or a network connection.

## Implementation Tasks

1. Define `AudioInputProvider`, `ASRProvider`, `TTSProvider`, and `AudioPlayer` interfaces.
2. Implement a recording-session state machine: preparing, recording, recognizing, waiting for response, synthesizing, playing, stopped, and error.
3. Implement audio-device selection, permission prompts, sample-format conversion, and input-level monitoring.
4. Integrate an ASR provider supporting final text, interim text, confidence, and cancellation.
5. Send ASR text to the Phase 2 conversation service and support user interruption of the current response.
6. Integrate a TTS provider that synthesizes and queues playback by sentence or streaming segment.
7. Map playback state to character animation, initially using playback volume to drive mouth/speaking behavior.
8. Provide input/output devices, voice provider, volume, autoplay, and privacy settings.

## Suggested Interfaces

- `ASRProvider.transcribe(audio, signal)`: returns text, language, confidence, and time segments.
- `TTSProvider.synthesize(text, options, signal)`: returns a playable audio stream and optional timing markers.
- `VoiceSession.start/stop/cancel()`: publishes session state changes through an event bus.
- `AudioPlayer.play(stream, onLevel)`: outputs only playback-level and lifecycle events, without exposing device details to the UI.

## Interaction and Privacy Rules

- Do not start the microphone before permission is granted; the recording indicator must remain visible.
- Immediately cancel unfinished ASR/TTS and clear temporary audio when recording stops, the application closes, or the session changes.
- Do not permanently save raw recordings by default; if saving is enabled, clearly show the location and deletion entry.
- Speech-recognition text is user input and remains subject to Persona, memory, and tool-permission rules.

## Phase Deliverables

- A usable voice-input, recognition, conversation, synthesis, and playback loop.
- ASR/TTS provider adapter interfaces and at least one configurable implementation.
- Recording/playback state linked to character animation.
- Audio-device, permission, privacy, and interruption settings.

## Acceptance Criteria

- A user can ask a voice question and hear a response while the character state remains continuous and understandable.
- Missing microphone permission, disconnected devices, recognition failure, synthesis failure, and playback failure all have recovery paths.
- When the user stops or speaks again, old recognition/playback tasks are cancelled and no audio overlaps.
- Default settings do not write recordings to long-term storage; disabling voice stops microphone access.

## Testing and Verification

- Provider contract tests: empty audio, noise, timeout, cancellation, segment ordering, and error mapping.
- VoiceSession state tests: normal loop, interruption, repeated start, device loss, and application exit.
- Integration tests: mock ASR/LLM/TTS driving the state machine and animation events.
- Manual tests: different sample rates, headphone/speaker echo, Mandarin Chinese, long text, and poor network quality.

## Risks and Follow-Up Entry Points

- Local models may consume CPU/GPU resources and affect rendering; monitor duration and resource use.
- TTS streaming sentence splitting affects latency and semantic continuity; the provider should own boundary policy.
- Voice feedback from Phase 5 tool execution must reuse the playback queue and interruption mechanism.

