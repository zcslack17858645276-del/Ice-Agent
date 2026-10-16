# Phase 7: Advanced Intelligence System Plan

## Goal

Add emotion signals, proactive reminders, schedule and task tracking, and environmental awareness while keeping every behavior controllable, explainable, and easy to disable.

## Scope and Boundaries

- Generate limited state signals from user-provided text, interaction, and time information.
- Support proactive reminders, schedule management, task tracking, and time/system-state awareness.
- Every proactive behavior is inspectable, pausable, silent, and deletable; default to low-interruption behavior.
- Do not perform undisclosed continuous monitoring, hidden screen capture, personality diagnosis, or high-risk automatic actions.

## Preconditions and Dependencies

- Phase 1 state machine, Phase 3 memory, Phase 5 tools/scheduler, and Phase 6 external tools expose stable interfaces.
- Define the event bus, background scheduler, notification channels, time zones, and sleep/wake policy.
- Define authorization, quiet hours, rate limits, and revocation for proactive behavior.

## Implementation Tasks

1. Define `UserSignal`, `MoodState`, `ProactiveTrigger`, `Reminder`, `Task`, and `QuietHours`.
2. Implement an event bus and scheduler supporting once, recurring, delayed, cancelled, resumed, and idempotent execution.
3. Add adapters for time, activity state, system power, and network signals at low sensitivity.
4. Aggregate emotion signals as low-confidence labels with evidence; never store an inference as a fact.
5. Implement reminder, schedule, and task-tracking UI with complete, postpone, ignore, and bulk-management actions.
6. Implement proactive-message policy using relevance, frequency, quiet hours, recent interaction, and user preferences.
7. Connect proactive behavior to Phase 1 expressions/animation, Phase 4 voice, and Phase 5 tools; high-risk actions still require confirmation.
8. Add a privacy-control panel for signal switches, retention, export, deletion, and pausing all proactive behavior.

## Proposed Interfaces

- `SignalProvider.read()`: returns source, timestamp, expiry, and privacy level.
- `ProactiveScheduler.schedule/cancel/runDue()`: every task has a stable ID and idempotency key.
- `CompanionPolicy.evaluate(context)`: returns allow, silent, or confirmation-required with a reason.
- `NotificationService.notify(message, channel)`: supports UI, system notifications, and voice while honoring quiet settings.

## Behavior and Privacy Rules

- Every proactive action has an explainable trigger and an off switch; prohibit high-frequency repeated reminders.
- Emotion analysis is only a short-term interaction signal. Without confirmation, it cannot write long-term memory or drive important decisions.
- Environmental sensing is disabled for high-sensitivity sources by default; permission changes are visible in settings.
- Scheduled tasks retain clear, predictable semantics across time zones, sleep, network changes, and application restarts.
- Proactive tool calls remain subject to Phase 5/6 policies; being proactive never bypasses confirmation.

## Phase Deliverables

- A pausable event bus and background scheduler.
- A minimally usable implementation of emotion signals, reminders, schedules, and task tracking.
- Time/system-state adapters and privacy controls.
- Low-interruption proactive policy with complete audit and explanation data.

## Acceptance Criteria

- Users can create, edit, complete, postpone, delete, and silence reminders; state restores correctly after restart.
- Proactive messages obey frequency, quiet-hours, authorization, and cancellation settings.
- Emotion signals are not displayed as diagnoses or written to long-term memory without confirmation.
- Chat and pet display remain usable when system-state services are unavailable or permissions are revoked.
- Proactive tool actions still show confirmation, result, and audit information.

## Testing and Verification

- Scheduler tests: time zones, daylight-saving changes, sleep/wake, restart recovery, duplicate triggers, and idempotency.
- Policy tests: quiet hours, rate limits, user cancellation, low confidence, and conflicting signals.
- Privacy tests: revoked permission, data deletion, memory isolation, and sensitive signals not persisted.
- End-to-end tests: reminder to notification/voice/animation and proactive task to confirmation/tool/audit.
- Long-running stability tests: background execution, resource use, log growth, and recovery from abnormal termination.

## Risks and Continuous Improvement

- Excessive proactive behavior reduces trust; start conservatively and use ignore/disable rates to tune policy.
- Emotion inference can be wrong; product copy and UI must communicate uncertainty.
- Scheduler and system notifications are long-running components; monitor failure rate, latency, and resource use.
