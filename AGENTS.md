# AGENTS.md

## 1. Project Constraints

This project must comply with the development standards defined in `RULES.md`, as well as the requirements in the overall development plan and the current phase plan.

When requirements conflict, follow this priority order:

1. Platform safety requirements.
2. Explicit requirements from the user's current request.
3. Project development rules.
4. Default implementation conventions.

## 2. Before Starting a Task

1. Identify the current task and its acceptance criteria.
2. Check the overall development plan and the current phase plan to confirm the task's phase and prerequisites.
3. Read the sections of `RULES.md` relevant to the current task.
4. Inspect the existing code, interfaces, and uncommitted changes to avoid duplicate implementations or overwriting user changes.
5. For tasks involving cross-module design, security, permissions, or data migrations, verify the relevant architectural constraints first.

Do not reread every document in full for every small task. However, for tasks involving multiple modules, architectural changes, or security boundaries, expand the scope of the review as necessary.

## 3. During Development

- Modify only what is necessary to complete the current task.
- Preserve existing architectural boundaries and interface contracts.
- Do not introduce undocumented dependencies.
- Do not bypass permission checks, user confirmations, or audit mechanisms.
- Do not describe unverified designs, tests, or features as completed.

## 4. Before Completing a Task

1. Run the relevant formatting checks, type checks, linters, and tests according to the scope of the changes.
2. Check for newly introduced security issues, interface compatibility problems, and unrelated modifications.
3. Update affected documentation and phase task statuses.
4. Report the modified files, implementation details, checks actually executed and their results, and any remaining unverified risks.

If a check cannot be executed or fails, explicitly report the situation. Never claim that a check has passed when it has not.

## 5. Rule Maintenance

- `RULES.md` is the single source of truth for detailed development standards.
- Do not duplicate the full set of rules in this file.
- Add new rules to the appropriate sections of the detailed standards.
- If the rules conflict with the actual implementation or phase plans, identify the discrepancy and propose a correction. Never treat a design goal as an implemented feature without verification.