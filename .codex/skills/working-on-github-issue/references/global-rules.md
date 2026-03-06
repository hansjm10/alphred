# Global Rules for GitHub Issue Delivery

These rules apply across all phases of the issue workflow.

## XML Output Discipline

- Every machine-oriented phase output must be a single XML root element matching the phase definition.
- Do not wrap XML artifacts in Markdown headings, bullets, or commentary when `--show-artifacts` is requested.
- Use nested tags and repeated child elements for lists. Do not place Markdown bullets inside XML elements.
- When a field has no entries, use an empty element such as `<required_edits />` instead of prose like "none".
- Preserve element names exactly as defined in [phases.md](phases.md).

## Evidence Standards

- Pull live issue state from GitHub before planning. The issue body alone is not enough if comments materially change scope.
- When you reference repository behavior, cite the relevant file and line numbers.
- When you reference executed validation, record the exact command and whether it passed or failed.
- When a finding points to issue text, code, or a prior artifact, include a `source` or `citation` attribute when the phase schema allows it.
- Keep observed facts, implementation intent, and review conclusions separate.
- If a claim depends on running code or tests, do not present it as verified unless the command actually ran.

## Basis Tags

Use these basis tags in findings, evidence, and review conclusions where the phase schema allows them:

- `[Basis: issue-read]` for claims grounded in the GitHub issue body or comments
- `[Basis: code-read]` for claims grounded in code inspection
- `[Basis: tests-run]` for claims grounded in executed tests
- `[Basis: manual-run]` for claims grounded in deterministic manual or runtime validation
- `[Basis: review-read]` for claims grounded in a review pass over a plan, diff, or execution artifact

Do not use one basis to justify a claim from a different source. For example, passing tests do not prove issue alignment; that remains `[Basis: issue-read]` plus `[Basis: code-read]`.

## Requirements Source of Truth

- Treat the live issue plus comments as the requirements source of truth unless the user provides newer direction in the current conversation.
- Convert acceptance criteria into explicit IDs such as `AC1`, `AC2`, and carry those references into the plan, execution, and delivery review.
- If the issue is ambiguous, stop and ask. Do not bury ambiguity inside later phases.

## Single-PR Reviewability Gate

- The draft plan must fit inside one clean, reviewable PR.
- If the work spans multiple independent deliverables, broad cross-layer migrations, or unclear sequencing, mark the plan as split-required and switch to `$split-reviewable-work`.
- Do not mask overscope with vague follow-up buckets.

## Step Granularity Rule

- Each execution step should change or protect one observable behavior.
- Each step must have a clear failing proof before the production change and a clear green proof after it.
- If a step is too large to review cleanly, split it before implementing.

## Behavior-First TDD Rule

- Write the smallest failing test or deterministic reproduction that proves the missing or incorrect behavior.
- Prefer public, contract, or user-visible boundaries over internal helper assertions.
- The failing proof must fail for the right reason. If the failure is noisy or unrelated, tighten the test first.
- Record red-phase evidence before implementing the fix.
- After the production change, rerun the targeted validation and record green-phase evidence.

## No Fake Green Rule

- Do not go green by weakening assertions, deleting meaningful coverage, or mocking away the behavior under test.
- Do not replace a behavioral proof with a structural proof unless the behavior is genuinely unreachable through public boundaries and the limitation is documented.
- When a behavior changes, remove stale tests and dead branches instead of keeping both paths by default.

## Review Gates

- Plan review blocks implementation until the plan is approved.
- Step review blocks the next step until the current step is approved.
- Delivery review blocks commit and PR packaging until the branch is ready.
- Required edits are blockers. Optional improvements are not.

## Cleanup and Development Hygiene

- This repository is in development. Breaking changes are acceptable when they simplify the codebase and align with the issue.
- Remove obsolete flags, code paths, and tests when the new behavior supersedes them.
- Keep changes scoped to the issue. Do not sweep unrelated work into the branch or PR.

## Verification Discipline

- Run targeted validation during each step and broader repo gates before packaging the PR.
- Prefer the narrowest command that proves the step during Phase 5A, then run the broader relevant suite in Phase 6.
- If a validation command is skipped, say exactly why and what residual risk remains.
- For dashboard changes, prefer behavior and accessibility validation over styling-only checks.

## PR Packaging Rule

- Use `Refs #{issue_number}` in commits by default.
- Use `Fixes #{issue_number}` in the PR body when the PR targets the default branch and is intended to close the issue.
- Summarize the delivered behavior and the actual validation run in the PR body.
- Re-check issue state before PR creation if the issue has active discussion during implementation.

## Human Summary Rule

- Keep the final user-facing summary short.
- Separate delivered behavior, validation run, PR status, and residual risks.
- Do not claim completion if required validation is still missing.
