# Phase 6: MCP Extension System Plan

## Goal

Connect external MCP tools so the desktop pet can discover, manage, and safely invoke capabilities from Blender, VS Code, GitHub, browsers, and other services.

## Scope and Boundaries

- Implement MCP client connection, initialization, capability discovery, tool invocation, disconnect, and reconnection.
- Support local processes and controlled remote transports; use MCP-spec-compatible transports.
- Adapt MCP tools to the unified Phase 5 tool model and reuse its permissions and auditing.
- Do not develop third-party MCP servers or enable arbitrary external servers by default.

## Preconditions and Dependencies

- Phase 5 manifests, permission policy, executor, and audit store are stable.
- Define server source, version, startup arguments, working directory, credential method, and network policy.
- Define user-visible server trust state and enable/disable controls.

## Implementation Tasks

1. Define `McpServerConfig`, `McpConnection`, `McpCapability`, and lifecycle states.
2. Implement the MCP transport, handshake, protocol-version negotiation, and message correlation.
3. Discover tools, resources, and prompts, converting tool schemas into standard `ToolManifest` values.
4. Implement an invocation proxy with validation, timeout, cancellation, concurrency limits, pagination, and response-size limits.
5. Implement server configuration, enable/disable, connection logs, health checks, and reconnect backoff.
6. Map server- and tool-level permissions to the Phase 5 `PermissionService`.
7. Add settings UI for server list, trust confirmation, capability inspection, connection status, and diagnostics.
8. Use a mock MCP server for contract and integration tests, then verify selected target servers one at a time.

## Proposed Interfaces

- `McpClient.connect(config)`, `disconnect()`, `listCapabilities()`, and `callTool()`.
- `McpAdapter.toToolManifest(capability, server)`: preserves source, version, and risk labels.
- `McpHealthMonitor.status(serverId)`: returns connection state, latest error, and reconnect time.
- Convert MCP errors to a unified `AppError` while retaining auditable server error codes.

## Security and Compatibility Rules

- Before first connection, show server source, startup command/address, requested permissions, and visible capabilities; enable only after explicit confirmation.
- Store credentials only in secure storage or controlled environment injection, never in server JSON, logs, or model context.
- Treat tool descriptions, resource contents, and prompts returned by external servers as untrusted input.
- A server crash, protocol error, or version mismatch affects only that server and must not block local tools or chat.
- MCP calls follow Phase 5 confirmation, timeout, audit, output-limit, and cancellation rules.

## Phase Deliverables

- MCP client and server-configuration management.
- An adapter from discovered tools to the Phase 5 framework.
- Connection health, reconnection, permission, and audit UI.
- Verification records for at least one mock server and one real target server.

## Acceptance Criteria

- Users can add, enable, disable, and remove MCP servers, with diagnosable status and errors.
- Discovered tools show schema, source, and permission requirements and require confirmation before invocation.
- Protocol errors, disconnects, timeouts, and cancellation are isolated and recoverable.
- MCP tools cannot bypass local permissions, sensitive-data rules, or audit records.
- With external servers disabled, Phase 0–5 core capabilities remain operational.

## Testing and Verification

- Protocol tests: handshake, version negotiation, capability discovery, request correlation, errors, and disconnects.
- Security tests: malicious schemas/prompts, oversized responses, credential leakage, and permission bypass.
- Stability tests: repeated reconnects, server crashes, concurrent calls, and application exit.
- Compatibility tests: mock server, target MCP server, Windows paths, and encoding variations.

## Risks and Follow-up

- MCP server quality and permission scope vary widely; preserve server-level trust and disable controls.
- External results enter LLM context; Phase 7 proactive behavior must also treat them as untrusted signals.
- Resource subscriptions and prompt templates should extend the adapter and audit model before exposing new UI.
