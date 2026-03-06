---
name: working-on-github-issue
description: |
  Orchestrated GitHub issue delivery workflow that pulls live issue state, extracts requirements and codebase context, drafts and reviews an implementation plan, executes ordered steps with behavior-first TDD and per-step reviews, then packages the branch into a pull request. Use when assigned a GitHub issue number or URL and expected to carry the work from issue intake through PR creation.
---

# Working on a GitHub Issue

Structured issue-delivery workflow modeled after `pr-review`, but optimized for implementation.

Announce at start: `I'm using the working-on-github-issue skill to implement issue #N.`

## Invocation

```text
/working-on-github-issue owner/repo#123
/working-on-github-issue https://github.com/owner/repo/issues/123
/working-on-github-issue 123                 # Uses current repo
/working-on-github-issue 123 --skip-pr       # Stop after packaging and verification
/working-on-github-issue 123 --show-artifacts
```

## Workflow Overview

```text
Phase 0 (fetch) ──┬──► Phase 1A (requirements) ──┬──► Phase 2 (plan) ──► Phase 3 (plan review) ──► Phase 4 (step plan + branch)
                  └──► Phase 1B (research)     ┘

Phase 4 ──► Phase 5 (step loop: red -> green -> refactor -> review) ──► Phase 6 (final verification + package) ──► Phase 7 (commit/push/pr) ──► Phase 8 (summary)
```

Parallelize Phase 1A and Phase 1B after the live issue fetch completes.

## Execution

### Step 1: Parse Input

Extract from user input:

- `owner`: repository owner, defaulting to the current repo
- `repo`: repository name, defaulting to the current repo
- `issue_number`: GitHub issue number
- `skip_pr`: optional flag to stop before `gh pr create`
- `show_artifacts`: optional flag to print phase artifacts as they complete

### Step 2: Phase 0 - Pull Live Issue State

Validate the environment first:

```bash
gh auth status
git rev-parse --is-inside-work-tree
gh repo view --json nameWithOwner,defaultBranchRef,url
```

Fetch the issue with REST endpoints:

```bash
gh api repos/{owner}/{repo}/issues/{issue_number}
gh api repos/{owner}/{repo}/issues/{issue_number}/comments --paginate
```

Capture at least:

- title, body, state, labels, assignees
- comments with clarifications or changed requirements
- whether the issue is blocked, already solved elsewhere, or obviously tracker-sized

Stop and escalate before coding if any of these are true:

- the issue is closed
- labels or comments mark it as blocked, duplicate, invalid, or intentionally deferred
- the scope is clearly too large for one reviewable PR
- acceptance criteria are too ambiguous to produce a defensible plan

If the issue is too large or spans multiple reviewable units, switch to `$split-reviewable-work` instead of forcing implementation.

Write an `<issue_context>` artifact. If `--show-artifacts` is set, print it immediately.

### Step 3: Phase 1A - Extract Requirements

Turn the issue and comments into a requirements pack before making implementation decisions.

Required contents:

- problem statement
- user-visible or system-visible outcome
- concrete acceptance criteria
- explicit non-goals or out-of-scope items
- constraints, dependencies, and blockers
- surfaces that must be validated before the PR is ready

If a requirement is unclear, stop and ask the user. Do not hide ambiguity inside the plan.

Write a `<requirements_pack>` artifact.

### Step 4: Phase 1B - Research the Codebase

Build local context in parallel with requirements extraction.

Always:

- load any package-local `AGENTS.md` instructions for the touched area
- use `rg` to find implementation and test touchpoints
- inspect adjacent tests before designing new ones
- inspect recent history for the touched paths when it helps explain current behavior

Useful commands:

```bash
rg -n "{keyword1}|{keyword2}" .
rg --files | rg "{area-or-package}"
git log --oneline -- {path1} {path2}
```

Capture:

- current behavior and relevant boundaries
- likely files or modules to change
- existing tests to extend or patterns to follow
- risk areas and cross-package effects
- repo-specific verification commands the final package must run

Write a `<research_pack>` artifact.

### Step 5: Phase 2 - Draft the Plan

Combine `<requirements_pack>` and `<research_pack>` into a single reviewable plan.

The draft plan must include:

- intended outcome
- touched modules and why they are involved
- ordered implementation steps
- test strategy for each behavior change
- explicit non-goals
- main risks and how they will be validated

Keep the plan single-PR sized. If you cannot make it reviewable without hand-waving or broad "cleanup later" buckets, stop and split the issue instead.

Write a `<draft_plan>` artifact.

### Step 6: Phase 3 - Review the Plan

Run a dedicated plan review before writing production code.

Preferred approach:

- spawn a fresh reviewer subagent with no carry-over context
- give it the issue, `<requirements_pack>`, `<research_pack>`, and `<draft_plan>`
- ask for gaps, sequencing problems, weak tests, hidden regressions, and overscope

If no subagent is available, perform the same review locally and write the findings explicitly.

The plan review must check:

1. Does the plan actually satisfy the issue's acceptance criteria?
2. Are the steps small enough to review and test independently?
3. Is the test strategy proving observable behavior rather than internals?
4. Does the plan remove obsolete paths instead of preserving legacy behavior without a reason?
5. Is the work still one reviewable PR?

Write a `<plan_review>` artifact with:

- `required_edits`
- `optional_improvements`
- `split_recommendation`

If the review finds material gaps, revise the draft plan and run one more fresh review pass.

### Step 7: Phase 4 - Finalize the Step Plan and Create the Branch

Turn the approved plan into an execution plan with explicit step boundaries.

Each step must define:

- the behavior being changed or protected
- the test or reproduction to write first
- the expected code touchpoints
- the verification command for the step
- the review check to pass before moving on

Create the working branch only after the plan is acceptable:

```bash
git checkout -b feat/issue-{issue_number}-{short-description}
git checkout -b fix/issue-{issue_number}-{short-description}
git checkout -b refactor/issue-{issue_number}-{short-description}
```

Track the ordered steps explicitly with the available plan or todo tool.

Write an `<execution_plan>` artifact.

### Step 8: Phase 5 - Execute Each Step with Behavior-First TDD

Work through the `<execution_plan>` one step at a time.

For each step:

1. Restate the exact behavior that must change or be protected.
2. Pick the highest-value test boundary that can prove that behavior.
3. Write or update the smallest failing test or deterministic reproduction.
4. Run it and confirm it fails for the right reason.
5. Implement the minimal production change.
6. Run the targeted verification until it is green.
7. Refactor if needed while keeping the behavior covered.
8. Run the step review before starting the next step.

Behavior-first TDD rules:

- Prefer tests at public, user-visible, or contract boundaries.
- Do not "go green" by weakening assertions, deleting coverage, or over-mocking the behavior away.
- A failing test must describe the missing behavior, not an implementation detail.
- If no automated test can faithfully prove the behavior, do deterministic runtime or manual validation and record exact evidence.
- When behavior changes invalidate old paths, remove obsolete code and stale tests instead of preserving legacy branches by default.

Alphred-specific guidance:

- For package work, prefer tests at the exported API or workflow boundary.
- For dashboard work, prefer route, component, and accessibility behavior over styling-only assertions.
- Use e2e only when the behavior depends on full-browser or multi-surface integration.

### Step 9: Phase 5 Review Gate - Review After Every Step

Do not chain steps together without an explicit review pass.

For each completed step:

- inspect the step diff
- confirm the behavior change matches the step goal
- check whether adjacent tests or docs should also move
- look for accidental feature creep or hidden cleanup that should be split out
- update the remaining plan if the step exposed a better sequence or a missing prerequisite

Preferred approach:

- spawn a fresh reviewer subagent with the step goal, current diff, and test output
- ask whether the step is behaviorally correct, reviewable, and cleanly scoped

If a reviewer finds issues, fix them before proceeding. Do not defer correctness problems to the end.

Write a `<step_review step="N">` artifact for each step.

### Step 10: Phase 6 - Final Verification and Package the Branch

After all steps are complete, review the branch as a single coherent delivery.

Always run the repo gates that match the touched surface:

```bash
pnpm lint
pnpm typecheck
pnpm typecheck:test
pnpm test
```

Add these when relevant:

```bash
pnpm build
pnpm test:e2e
pnpm test:e2e:no-test-routes
pnpm test:e2e:build-gate
```

Before moving to PR creation:

- inspect `git diff --check`
- inspect `git diff --stat`
- confirm dead code, stale tests, and obsolete docs were cleaned up
- confirm the branch still tells one coherent issue story
- summarize behavior delivered, tests run, and any follow-up work that remains intentionally out of scope

Write a `<delivery_review>` artifact.

### Step 11: Phase 7 - Commit, Push, and Create the PR

Package the work into a clean PR after verification passes.

Commit using a conventional format and keep issue linkage explicit:

```bash
git status --short
git add {intended_files}
git commit -m "type(scope): concise summary" -m "Refs #{issue_number}"
git push -u origin {branch_name}
```

Create the PR with a reviewable title and body:

```bash
gh pr create --title "type(scope): concise summary" --body "$(cat <<'EOF'
## Summary
- <key change 1>
- <key change 2>

## Testing
- pnpm lint
- pnpm typecheck
- pnpm typecheck:test
- pnpm test

Fixes #{issue_number}
EOF
)"
```

Use `Fixes #{issue_number}` in the PR body when the PR targets the default branch. Keep commits on `Refs #{issue_number}` unless there is a specific reason to close from a commit.

Stage only the files that belong to the issue. Do not sweep unrelated local artifacts or other in-progress work into the PR.

If `--skip-pr` is set, stop after packaging notes and verification instead of running `gh pr create`.

Write a `<pr_package>` artifact with branch, commit, PR URL or status, and testing summary.

### Step 12: Phase 8 - Final Summary

End with a short human summary covering:

- the behavior delivered
- the key tests and validations run
- the PR URL or why PR creation was skipped
- any explicit follow-ups or residual risks

## Output Streaming

By default, write artifacts to a working directory such as:

```text
.codex-artifacts/working-on-github-issue/{owner}-{repo}#{issue_number}/
```

Default user-facing output:

1. Short delivery summary
2. PR URL or creation status

If `--show-artifacts` is set, also print each artifact as it completes:

1. `<issue_context>`
2. `<requirements_pack>`
3. `<research_pack>`
4. `<draft_plan>`
5. `<plan_review>`
6. `<execution_plan>`
7. `<step_review step="N">` for each step
8. `<delivery_review>`
9. `<pr_package>`

## Error Handling

- If `gh auth status` fails, stop and report that GitHub authentication is required.
- If issue fetch fails, stop with the REST error and do not infer missing issue state.
- If the issue is closed, blocked, or too broad, stop and explain why implementation did not start.
- If the plan review says the work is not single-PR sized, switch to `$split-reviewable-work`.
- If a step cannot be validated with a meaningful automated or deterministic check, say so explicitly in the step review and final summary.
- If verification fails, fix the failures before PR creation.
- If PR creation fails, keep the branch packaged, report the error, and include the exact branch and commit state in `<pr_package>`.

## Heuristics

- Prefer one observable behavior change per execution step.
- Prefer deleting superseded code paths over leaving compatibility shims in development.
- Treat review findings as blockers when they affect correctness, scope, or test validity.
- Re-fetch the issue before PR creation if the issue has been active during implementation.
- Fresh reviewer context is better than a reviewer inheriting the implementer's assumptions.

This skill complements `$split-reviewable-work`: split the issue first when the plan review cannot honestly keep the work within one clean PR.
