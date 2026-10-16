# Phase 2: AI Conversation System Plan

## Goal

Integrate a configurable large language model to provide text conversation, context management, and consistent personality control.

## Scope and Boundaries

- Support the OpenAI Compatible API while preserving an adapter boundary for local models.
- Provide configuration management for the model, endpoint, temperature, and maximum output.
- Implement message history, streaming output, generation cancellation, error retries, and a basic personality prompt.
- Do not implement long-term memory, tool calling, voice, or autonomous tasks in this phase.

## Prerequisites and Dependencies

- The chat panel from Phase 0 and states such as `THINKING` from Phase 1 are available.
- Define API key storage; keys must not enter the frontend bundle, logs, or repository.
- Determine the default model, context-window policy, and network timeout limit.

## Implementation Tasks

1. Define `ChatMessage`, `Conversation`, `ModelConfig`, `StreamChunk`, and error types.
2. Implement the `LLMProvider` interface and an OpenAI Compatible provider, isolating the HTTP client and vendor-specific fields.
3. Implement the conversation service: message appending, streaming-token merging, cancellation, retries, and context trimming.
4. Implement Persona configuration: name, personality, response style, behavior rules, and version.
5. Map the conversation lifecycle to desktop pet states: `THINKING` while requesting, working/speaking while outputting, and restoration after completion.
6. Provide endpoint, model, and personality configuration in settings; use a secure storage adapter for sensitive configuration.
7. Add understandable user messages for network failure, rate limiting, timeout, invalid responses, and empty content.

## Suggested Interfaces

- `LLMProvider.stream(request, signal)`: supports cancellation signals and outputs normalized `StreamChunk` values.
- `ConversationService.sendMessage(conversationId, content)`: returns a subscribable stream and the final message.
- `PersonaService.getActivePersona()`: returns a versioned and validated personality configuration.
- The API layer consistently returns `AppError { code, message, retryable, details? }`; the UI does not parse vendor error text directly.

## Context and Personality Rules

- The system personality prompt stays at the beginning of the message sequence and records its source version.
- User, model, and system messages must be stored separately; never concatenate user text into a system instruction.
- When the context limit is reached, trim earlier messages according to policy and log the number trimmed without recording complete sensitive content.
- If a streaming message is interrupted, save a recognizable incomplete state; resending must not append the same user message twice.

## Phase Deliverables

- Text chat configurable for an OpenAI Compatible API.
- Streaming output, cancellation, retries, and model switching.
- A versioned Persona configuration and editable settings page.
- Vendor-independent LLM and conversation interfaces.

## Acceptance Criteria

- After a user sends a message, a streaming response is visible and the desktop pet state changes accordingly.
- Network errors, timeouts, rate limits, and cancellation produce stable UI results without crashing the application.
- Switching personality or model affects only new requests and does not damage historical conversations.
- The API key is not visible in process logs, build artifacts, or error messages.
- Core tests can run offline with a mock provider.

## Testing and Verification

- Provider contract tests: normal streams, empty streams, malformed responses, timeouts, rate limits, and cancellation.
- Conversation tests: context trimming, retry idempotency, stream merging, concurrent sends, and error recovery.
- Persona tests: defaults, version upgrades, invalid fields, and isolation of injection-style user text.
- Integration tests: the complete chat UI, state machine, and mock LLM flow.

## Risks and Follow-Up Entry Points

- Compatible APIs do not all use exactly the same stream format; adapt through providers rather than contaminating core models.
- The memory system will change the sources of context; Phase 3 should extend through `ContextAssembler`.
- Tool calling requires new permission and approval workflows and cannot simply reuse ordinary text messages.

