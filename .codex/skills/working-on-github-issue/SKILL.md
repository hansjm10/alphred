---
name: working-on-github-issue
description: |
  Orchestrated GitHub issue delivery workflow that pulls live issue state, extracts requirements and codebase context, drafts and reviews an implementation plan, executes ordered steps with behavior-first TDD and per-step reviews, then packages the branch into a pull request. Use when assigned a GitHub issue number or URL and expected to carry the work from issue intake through PR creation.
---

# GitHub Issue Delivery Orchestrator

Evidence-based issue implementation workflow with explicit XML artifacts, plan review gates, behavior-first TDD, and PR packaging.

Announce at start: `I'm using the working-on-github-issue skill to implement issue #N.`

## Invocation

```text
/working-on-github-issue owner/repo#123
/working-on-github-issue https://github.com/owner/repo/issues/123
/working-on-github-issue 123
/working-on-github-issue 123 --skip-pr
/working-on-github-issue 123 --show-artifacts
```

## Workflow Overview

```text
Phase 0 (fetch) ──┬──► Phase 1A (requirements) ──┬──► Phase 2 (plan) ──► Phase 3 (plan review) ──► Phase 4 (execution plan + branch)
                  └──► Phase 1B (research)     ┘

Phase 4 ──► Phase 5A (step execution: red -> green -> refactor) ──► Phase 5B (step review) ──► Phase 6 (delivery review) ──► Phase 7 (package PR) ──► Phase 8 (summary)
```

Parallelize Phase 1A and Phase 1B after the live issue fetch completes.

## Artifact Contract

- Apply all rules from [references/global-rules.md](references/global-rules.md).
- Use the exact XML output formats in [references/phases.md](references/phases.md).
- Follow the patterns in [references/examples.md](references/examples.md).
- When `--show-artifacts` is set, emit each phase artifact as a standalone XML block with no surrounding prose.
- By default, write artifacts under `.codex-artifacts/working-on-github-issue/{owner}-{repo}#{issue_number}/` and only print the final human summary plus PR status.

## Execution

### Step 1: Parse Input

Extract from user input:

- `owner`: repository owner, defaulting to the current repo
- `repo`: repository name, defaulting to the current repo
- `issue_number`: GitHub issue number
- `skip_pr`: optional flag to stop before `gh pr create`
- `show_artifacts`: optional flag to print XML artifacts as phases complete

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

Capture:

- title, body, state, labels, assignees
- comments with clarifications or changed requirements
- blockers, duplicates, or deferral signals
- whether the issue is still plausibly one reviewable PR

If the issue is closed, blocked, duplicate, or too broad for one clean PR, stop before implementation. If it needs to be split, switch to `$split-reviewable-work`.

Output format: See Phase 0 in [references/phases.md](references/phases.md).

### Step 3: Phases 1A and 1B - Build the Requirements and Research Packs

Run these in parallel after Phase 0 succeeds.

Phase 1A, requirements extraction:

- turn the issue body and comments into explicit outcomes, criteria, constraints, non-goals, dependencies, ambiguities, and validation surfaces
- stop and ask the user if the requirements are too ambiguous to support a defensible plan

Output format: See Phase 1A in [references/phases.md](references/phases.md).

Phase 1B, codebase research:

- load any package-local `AGENTS.md` instructions for the touched area
- use `rg` to find implementation and test touchpoints
- inspect adjacent tests before designing new ones
- inspect recent history for touched paths when it clarifies behavior
- capture repo-specific verification commands that the final package must run

Useful commands:

```bash
rg -n "{keyword1}|{keyword2}" .
rg --files | rg "{area-or-package}"
git log --oneline -- {path1} {path2}
```

Output format: See Phase 1B in [references/phases.md](references/phases.md).

### Step 4: Phase 2 - Draft the Plan

Combine `<requirements_pack>` and `<research_pack>` into a single reviewable plan.

The plan must stay single-PR sized and include:

- intended outcome
- touched modules and why they are involved
- ordered implementation steps
- test strategy for each behavior change
- explicit non-goals
- major risks and how they will be validated

Apply all rules from [references/global-rules.md](references/global-rules.md).
Output format: See Phase 2 in [references/phases.md](references/phases.md).

### Step 5: Phase 3 - Review the Plan

Run a dedicated plan review before writing production code.

Preferred approach:

- spawn a fresh reviewer subagent with no carry-over context
- provide the issue, `<requirements_pack>`, `<research_pack>`, and `<draft_plan>`
- ask for acceptance-criteria gaps, sequencing problems, weak tests, hidden regressions, and overscope

If no subagent is available, perform the same review locally and still output the XML artifact.

If `<plan_review>` returns `REVISE_PLAN`, revise the plan and run one more fresh review pass. If it returns `SPLIT_ISSUE`, stop and switch to `$split-reviewable-work`.

Apply all rules from [references/global-rules.md](references/global-rules.md).
Output format: See Phase 3 in [references/phases.md](references/phases.md).

### Step 6: Phase 4 - Finalize the Execution Plan and Create the Branch

Turn the approved plan into an execution plan with explicit step boundaries.

Each step must define:

- the behavior being changed or protected
- the first failing test or deterministic reproduction
- the expected code touchpoints
- the verification command for that step
- the review focus before moving on

Create the branch only after the plan is approved:

```bash
git checkout -b feat/issue-{issue_number}-{short-description}
git checkout -b fix/issue-{issue_number}-{short-description}
git checkout -b refactor/issue-{issue_number}-{short-description}
```

Track the ordered steps explicitly with the available plan or todo tool.

Output format: See Phase 4 in [references/phases.md](references/phases.md).

### Step 7: Phase 5A - Execute Each Step with Behavior-First TDD

Work through `<execution_plan>` one step at a time.

For each step:

1. Restate the exact behavior that must change or be protected.
2. Choose the highest-value public or contract boundary that can prove that behavior.
3. Write or update the smallest failing test or deterministic reproduction.
4. Run it and confirm it fails for the correct reason.
5. Implement the minimal production change.
6. Run the targeted verification until it is green.
7. Refactor if needed while keeping behavior covered.
8. Record the red, green, and refactor evidence in `<step_execution>`.

Behavior-first TDD rules:

- prefer tests at public, user-visible, or contract boundaries
- do not go green by weakening assertions, deleting coverage, or mocking the behavior away
- a failing test must describe the missing behavior, not an implementation detail
- if no automated test can faithfully prove the behavior, run a deterministic manual validation and record exact evidence
- when behavior changes invalidate old paths, remove obsolete code and stale tests instead of preserving legacy branches by default

Output format: See Phase 5A in [references/phases.md](references/phases.md).

### Step 8: Phase 5B - Review After Every Step

Do not chain steps together without an explicit review pass.

For each completed step:

- inspect the step diff
- confirm the behavior change matches the step goal
- check whether adjacent tests or docs should also move
- look for accidental feature creep or hidden cleanup that should be split out
- update the remaining plan if the step exposed a better sequence or a missing prerequisite

Preferred approach:

- spawn a fresh reviewer subagent with the step goal, `<step_execution>`, current diff, and test output
- ask whether the step is behaviorally correct, reviewable, and cleanly scoped

If `<step_review>` returns `REVISE_STEP`, fix the issues and rerun the review before starting the next step.

Apply all rules from [references/global-rules.md](references/global-rules.md).
Output format: See Phase 5B in [references/phases.md](references/phases.md).

### Step 9: Phase 6 - Final Verification and Delivery Review

After all steps are complete, review the branch as one coherent delivery.

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

Apply all rules from [references/global-rules.md](references/global-rules.md).
Output format: See Phase 6 in [references/phases.md](references/phases.md).

### Step 10: Phase 7 - Commit, Push, and Create the PR

Package the work only after Phase 6 says the branch is PR-ready.

Use a conventional commit and explicit issue linkage:

```bash
git status --short
git add {intended_files}
git commit -m "type(scope): concise summary" -m "Refs #{issue_number}"
git push -u origin {branch_name}
```

Stage only the files that belong to the issue. Do not sweep unrelated local artifacts or in-progress work into the PR.

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

If `--skip-pr` is set, stop after packaging notes and verification instead of running `gh pr create`.

Output format: See Phase 7 in [references/phases.md](references/phases.md).

### Step 11: Phase 8 - Final Summary

End with a short human summary covering:

- the behavior delivered
- the key tests and validations run
- the PR URL or why PR creation was skipped
- any explicit follow-ups or residual risks

When `--show-artifacts` is set, emit the XML artifact from Phase 8 first.

Output format: See Phase 8 in [references/phases.md](references/phases.md).

## Output Streaming

By default, do not print XML artifacts. Write them to the artifact directory and only output:

1. the final human summary
2. the PR URL or creation status

If `--show-artifacts` is set, print each artifact as soon as its phase completes:

1. `<issue_context>`
2. `<requirements_pack>`
3. `<research_pack>`
4. `<draft_plan>`
5. `<plan_review>`
6. `<execution_plan>`
7. `<step_execution step="N">` for each step
8. `<step_review step="N">` for each step
9. `<delivery_review>`
10. `<pr_package>`
11. `<delivery_summary>`

## Error Handling

- If `gh auth status` fails, stop and report that GitHub authentication is required.
- If issue fetch fails, stop with the REST error and do not infer missing issue state.
- If the issue is closed, blocked, duplicate, or too broad, stop before implementation and record why in `<issue_context>`.
- If plan review returns `SPLIT_ISSUE`, switch to `$split-reviewable-work`.
- If a step cannot be validated with a meaningful automated or deterministic check, say so explicitly in `<step_execution>`, `<step_review>`, and the final summary.
- If verification fails, fix it before PR creation.
- If PR creation fails, keep the branch packaged, report the error, and include the exact branch and commit state in `<pr_package>`.

This skill complements `$split-reviewable-work`: split the issue first when the plan review cannot honestly keep the work within one clean PR.
