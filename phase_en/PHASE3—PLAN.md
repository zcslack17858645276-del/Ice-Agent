# Phase 3: Memory System Plan

## Goal

Save short-term conversations and selected long-term information so the desktop pet can reliably use user preferences, important events, and usage habits in later sessions.

## Scope and Boundaries

- Use SQLite for structured data and chat history.
- Abstract a vector storage interface that can connect to FAISS, Chroma, or another implementation.
- Support memory extraction, confirmation, retrieval, updating, deletion, and export.
- Minimize stored memory by default; do not implement complex user profiles or cross-device synchronization in this phase.

## Prerequisites and Dependencies

- Phase 2 provides standardized conversation, message, and Persona interfaces.
- Define the local database location, migration tool, backup policy, and encryption requirements.
- Determine the embedding model source, dimension, version, and offline-failure policy.

## Implementation Tasks

1. Design the SQLite schema for conversations, messages, memory entries, tags, sources, status, timestamps, and deletion markers.
2. Establish migrations. Record migration versions independently from application versions and support rollback or safe startup termination on failure.
3. Implement a short-term context service that returns messages by time, conversation, and token budget.
4. Implement a long-term memory extractor that extracts user preferences, events, and habits from conversation candidates, with confidence and source-message references.
5. Implement memory review rules: high-risk or low-confidence content requires user confirmation, with rejection and permanent deletion supported.
6. Implement a vector-index adapter, insertion/update/deletion, and similarity search, recording the embedding-model version.
7. Implement `ContextAssembler`, assembling LLM context by relevance, time, freshness, and privacy level.
8. Provide memory listing, search, deletion, clear-all, and export functions in settings.

## Suggested Data Interfaces

- `MemoryRecord { id, kind, content, sourceMessageId, confidence, privacy, createdAt, updatedAt }`.
- `MemoryStore.create/update/delete/list(query)`: all writes pass schema validation.
- `MemorySearch.search(query, filters, limit)`: returns records, scores, sources, and model versions.
- `ContextAssembler.build(conversation, query, budget)`: returns read-only context fragments with source markers.

## Data and Privacy Rules

- Manage raw chat and long-term memory separately; every memory entry must be traceable to its source and deletable independently.
- Passwords, tokens, financial information, health information, and other highly sensitive content are not extracted into long-term memory by default.
- A user deletion must also clear structured records, vector indexes, and caches.
- Export files must not contain keys and must be explicitly initiated by the user; validate schema and size before import.

## Phase Deliverables

- SQLite database, migration scripts, and repository layer.
- Short-term and long-term memory services and a vector storage adapter.
- Memory management UI with export and deletion capabilities.
- A context assembly interface callable by Phase 2.

## Acceptance Criteria

- After restarting the application, recent conversations can be restored and long-term memories can be retrieved by relevant queries.
- Memory entries include source, time, confidence, and privacy level.
- After a user deletes a memory, it no longer appears in later retrieval or context.
- Database migrations can be executed repeatedly without data loss; migration failure produces a clear application error.
- If vector services or embeddings fail, short-term chat continues to work with a structured fallback.

## Testing and Verification

- Migration tests: empty database, old versions, repeated execution, and failure rollback.
- Repository tests: CRUD, pagination, soft/hard deletion, and concurrent access.
- Retrieval tests: relevance filtering, thresholds, version changes, and no-result fallback.
- Privacy tests: sensitive-data exclusion, cascading deletion, and sanitized export.
- Integration tests: the complete conversation-to-extraction-to-retrieval-to-context-injection flow.

## Risks and Follow-Up Entry Points

- Switching vector models makes indexes incompatible; support rebuilding and version coexistence.
- Automatic extraction may create incorrect memories; confirmation and traceability are release requirements.
- Voice transcripts from Phase 4 enter short-term context by default; moving them to long-term memory must follow the same review process.

