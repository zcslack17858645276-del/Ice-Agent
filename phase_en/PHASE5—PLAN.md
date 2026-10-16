# Phase 5: Agent Capability Expansion Plan

## Goal

Expand the desktop pet from a chat assistant into a personal agent that can execute file, application, system, and automation tasks under explicit user authorization.

## Scope and Boundaries

- Establish unified models for tool registration, parameter validation, invocation, results, permissions, and auditing.
- Initially support file search/organization, application launching, restricted command execution, system-state reads, scheduled tasks, and simple workflows.
- All side-effecting tools require user confirmation or prior authorization by default. No capability may bypass operating-system permissions.
- Tool execution follows LLM decisions, but the LLM may only submit structured tool requests.

## Preconditions and Dependencies

- Phase 2 conversation services and Phase 3 context services are available.
- The Phase 0 Rust host can provide controlled system APIs.
- Permission levels, allowed paths, command allowlists, timeouts, cancellation, and audit-retention policies are defined first.

## Implementation Tasks

1. Define `ToolManifest`, `ToolRequest`, `ToolResult`, `PermissionPolicy`, and `AuditEvent`.
2. Implement tool registration, discovery, version validation, parameter-schema validation, and lifecycle management.
3. Implement safe file tools: search, directory listing, metadata reads, and copy/move operations to user-approved targets.
4. Implement application launch and system-state reads through a platform adapter that isolates Windows APIs.
5. Implement command allowlists, argument validation, working-directory restrictions, timeouts, output limits, and cancellation.
6. Implement scheduled tasks and workflows with step states, retry policy, failure stop, cancellation, and execution history.
7. Add confirmation dialogs, pre-authorization management, denial results, and audit-log viewing.
8. Normalize tool results before returning them to the LLM, and cap invocation count and total execution time.

## Proposed Interfaces

- `ToolRegistry.list/get(manifest)`: returns only enabled and version-compatible tools.
- `ToolExecutor.execute(request, context)`: performs permission checks first and returns a structured result.
- `PermissionService.check(request, userContext)`: returns allow, confirmation-required, or deny with a reason.
- `AuditStore.append(event)`: records tool, caller, parameter summary, result status, duration, and user decision.

## Security and Execution Rules

- Normalize file paths and restrict them to explicitly authorized roots; reject traversal.
- Command execution is disabled by default. Allowlists must constrain executable files and argument patterns; never concatenate shell strings.
- Deletion, overwrite, sending, installation, upload, and other irreversible or external side effects require a second confirmation.
- Limit tool output by size, type, and duration. Never return raw credentials or the complete environment to the model.
- Every invocation carries cancellation, timeout, and audit context; child processes are reaped on application exit.

## Phase Deliverables

- A unified tool framework with at least three local tools.
- Permission confirmation, pre-authorization, auditing, and failure recovery.
- A minimally usable scheduler/workflow implementation.
- A bounded execution loop from LLM request through tool result.

## Acceptance Criteria

- The model cannot bypass policy to execute tools; unauthorized calls are rejected with a reason.
- Valid file operations, application launches, and system-state reads work; risky operations pause for confirmation.
- Timeout, cancellation, crash, and duplicate requests do not leave orphan processes or repeated side effects.
- Audits identify who invoked which tool, when, the result, and whether the user confirmed.
- Workflows stop on failure or retry only under an explicit policy, and their state can be inspected.

## Testing and Verification

- Permission tests: traversal, allowlist bypass, dangerous arguments, denial, and expired authorization.
- Executor tests: timeout, cancellation, output truncation, duplicate requests, and child-process cleanup.
- Tool-contract tests: schema validation, incompatible versions, missing parameters, and error mapping.
- Workflow tests: ordering, failure stop, retry limits, pause, resume, and cancellation.
- Security exercises: place malicious instructions in user text, web content, and tool results and verify no privilege escalation.

## Risks and Follow-up

- System-tool boundaries determine the product security level; every new tool must ship with a manifest and policy first.
- Phase 6 MCP tools must reuse this phase's permission, audit, and cancellation mechanisms.
- Scheduled tasks introduce background execution and notification concerns; integrate them with proactive-behavior scheduling in Phase 7.
