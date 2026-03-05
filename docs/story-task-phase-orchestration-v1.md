# Story-Task Phase Orchestration v1

Status: Draft (2026-03-05)
Owner: Dashboard/Core architecture
Related issues: #280, #281, #282, #283, #284, #285, #286, #287

## 1) Goal

Implement a phase-based, SDK-agnostic workflow system where:

- Humans and/or agents create and refine story/task plans.
- A story runs on its own feature worktree.
- Tasks execute sequentially (or policy-driven parallelism later) in child task worktrees.
- Each task runs a deterministic work -> review/fix loop.
- Completed task changes merge up into the story worktree.
- Agents can leave durable notes for downstream agents/phases in SQL.

## 2) Core Principles

- Server-orchestrated state machine: UI does not orchestrate multi-step business flow.
- Provider abstraction: orchestration does not depend on Codex-specific behavior.
- Deterministic transitions: phase progression is explicit and auditable.
- Bounded context: all handoff data injected into prompts remains size-limited and traceable.
- Fresh sessions per phase: no hidden cross-phase chat state outside persisted artifacts/notes.

## 3) Runtime Model

### 3.1 Hierarchy

- Story workflow run is the parent execution scope.
- Task workflow runs are child scopes linked to a story.
- Phase nodes run inside each workflow run using published workflow trees.

### 3.2 Branch/worktree model

- Story workspace: `main` (or repo default branch) -> `story/<id>-<hash>`.
- Task workspace: created from current story branch head.
- Task completion merges task branch into story branch.
- Story completion later merges story branch to target integration branch.

### 3.3 Orchestration entry points

- Story orchestration action (single API) advances story through:
  - draft/needs-breakdown
  - breakdown generation
  - breakdown approval
  - task queue scheduling
- Explicit task start action launches task run and links status/run atomically.

## 4) Phase Contracts

### 4.1 Task run baseline phases

- `work`: implement changes.
- `review`: evaluate and emit routing decision.
- `fix`: apply requested changes.
- `approved`: summarize completion and residual risks.

Routing decisions: `approved | changes_requested | blocked | retry`.

### 4.2 Planner contract

Story breakdown output must be strict schema-validated JSON before mutating tasks.

## 5) Agent Handoff Notes

### 5.1 Existing support we can reuse

- `phase_artifacts` already supports `artifact_type = 'note'`.
- Executor context handoff already exists with deterministic bounds and metadata.

### 5.2 Gap

Default upstream context policy includes `report` artifacts and excludes `note` artifacts, and current handoff scope is primarily direct predecessors in one run.

### 5.3 v1 handoff contract

Introduce a first-class note contract (issue #287):

- Scope keys: `storyId`, `taskId` (optional), `workflowRunId`, `runNodeId`, `phase`.
- Producer fields: `authorType`, `authorLabel`, `createdAt`, `kind`.
- Content fields: `summary`, `actions`, `risks`, `assumptions`, `links`.
- Consumption rules: deterministic selection and bounded injection policy for next phase/task.

## 6) SDK-Agnostic Provider Contract

Orchestrator interacts with providers via a stable interface:

- input: prompt, bounded context entries, execution permissions
- stream: structured events + terminal result
- output: artifacts + optional routing metadata

Provider-specific options (for example model/reasoning knobs) stay inside adapter implementations.

## 7) Failure and Recovery

- Revision conflicts remain optimistic and explicit (`409`).
- Task launch failures do not hide behind status transitions.
- Merge-up failure keeps task/story state explicit and recoverable.
- Retry and blocked paths are explicit routes, not implicit loops.

## 8) Implementation Sequence

1. #281 server-side story orchestration endpoint/service.
2. #282 explicit task start API, decouple move status from run launch.
3. #283 strict planner schema + async lifecycle.
4. #284 workspace lifecycle/reconciliation/cleanup.
5. #287 first-class handoff notes channel and injection policy.
6. #285 policy-driven workflow seed permissions.
7. #280 seeding abstraction refactor.

## 9) Non-goals for v1

- Multi-repo orchestration.
- Arbitrary DAG scheduling policies beyond deterministic defaults.
- Unbounded free-form memory injection across all historical runs.
