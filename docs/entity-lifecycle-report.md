# Alphred Entity Lifecycle + Interaction Report

Date: 2026-03-03  
Scope: Current entities as implemented in the monorepo (DB + dashboard HTTP API + dashboard UI + CLI where relevant).

This report is lifecycle-oriented: how entities are created, interacted with, related to each other, and how they reach a terminal/natural end (or where that is currently missing).

Primary references:
- Database schema: `packages/db/src/schema.ts`
- Work item lifecycle rules: `packages/core/src/workItemLifecycle.ts`
- Run lifecycle semantics: `DESIGN.md`, `packages/core/README.md`
- Dashboard HTTP API contracts: `apps/dashboard/README.md` (base path: `/api/dashboard`)
- Dashboard integration service surface: `apps/dashboard/src/server/dashboard-service.ts`

---

## 1) Entity Map (What exists today)

### Core operator-facing entities
- **Repository** (managed SCM repo registry)
- **Work item** (epic/feature/story/task) + **work item events** (audit + realtime)
- **Workflow tree** (versioned topology) + **draft workflow** (editable next version)
- **Workflow run** (execution instance) + **run nodes** (phase attempts)
- **Run worktree** (filesystem snapshot tied to a run)

### Supporting entities (mostly “behind the scenes”, but surfaced in Run Detail)
- **Phase artifacts** (reports/notes/logs)
- **Routing decisions** (structured outcome of guarded routing)
- **Diagnostics snapshots** (bounded attempt inspection)
- **Run-node stream events** (timeline/streaming UI)
- **Agent catalog** (providers + models; stored in `agent_models`)
- **Prompt templates** + **guard definitions** (owned by workflow draft/publish flows)

---

## 2) Relationships (How entities connect)

- Repository **has many** work items (`work_items.repository_id`).
- Repository **has many** board events (`work_item_events.repository_id`), which are streamed to the board UI.
- Workflow tree (a specific version) **has many** nodes/edges (`tree_nodes`, `tree_edges`).
- Workflow run **belongs to** a workflow tree version (`workflow_runs.workflow_tree_id`).
- Workflow run **has many** run nodes (`run_nodes.workflow_run_id`), plus stream events/diagnostics/artifacts/decisions.
- Workflow run **may have** run worktrees (`run_worktrees.workflow_run_id`). A run can exist without a worktree when launched without a repository context.

---

## 3) Repository

### Data model
- Table: `repositories`
- Key state field: `clone_status` ∈ `pending | cloned | error`

### Creation
- **Dashboard HTTP API**: `POST /api/dashboard/repositories`
  - Creates a repository row with `cloneStatus = pending`.
- **CLI**: `alphred repo add --name <name> (--github <owner/repo> | --azure <org/project/repo>)`
  - Persists repository config (does not necessarily clone immediately).
- **Run launch auto-registration (CLI)**: `alphred run --repo github:owner/repo` can auto-register an alias.

### Interaction
- **Sync/clone**
  - Dashboard HTTP API: `POST /api/dashboard/repositories/[name]/sync`
  - CLI: `alphred repo sync <name> [--strategy ...]`
  - Outcome updates `clone_status` and `local_path` (and may surface conflicts).
- **Used as run context**
  - Dashboard UI “Launch run with this repo” (preselects repository on `/runs`).
  - Run launch can optionally create a run worktree.

### Natural end / terminal state
- There is no “terminal” status for a repository; it’s long-lived configuration.
- **CLI removal exists**: `alphred repo remove <name> [--purge]`
  - Notably: removal is blocked if `run_worktrees` references the repository (the CLI checks this explicitly), so repositories effectively become non-removable once they’ve been used for a run worktree.

### Current UI coverage
- `/repositories`
  - List repositories, add repository (GitHub-only in dashboard), sync/retry, show local path.
- No dashboard affordance for remove/archive/edit repository config.

---

## 4) Work items (Epic / Feature / Story / Task)

### Data model
- Table: `work_items`
  - State: `type`, `status`, `revision` (optimistic concurrency), plus fields like title/description/tags/assignees/priority/estimate.
- Table: `work_item_events`
  - Event types include: `created`, `updated`, `status_changed`, `reparented`, `breakdown_proposed`, `breakdown_approved`.
  - Events power the repository board realtime stream.

### Lifecycle rules (status machine)
Status enums live in `@alphred/shared` and allowed transitions are enforced in `@alphred/core`:
- Epic/Feature: `Draft → Approved → InProgress ↔ Blocked → InReview ↔ InProgress → Done`
- Story: `Draft → NeedsBreakdown ↔ BreakdownProposed → Approved → InProgress ↔ InReview → Done`
- Task: `Draft → Ready → InProgress ↔ Blocked → InReview ↔ InProgress → Done`

Hierarchy constraints:
- Parent/child type constraints are strict: `epic → feature → story → task` only.

### Creation
- **Dashboard HTTP API**
  - `POST /api/dashboard/repositories/[repositoryId]/work-items` creates a work item (any type).
- **UI**
  - Work items are displayed on the repository board and in story pages, but there is currently no obvious “create work item” flow wired from the board/stories UI (creation is primarily exercised via fixtures/tests, and via breakdown proposal).
- **Story breakdown proposal creates tasks**
  - Proposing breakdown inserts child tasks (`task`, `Draft`, `parentId = storyId`) and updates story status to `BreakdownProposed`.

### Interaction
- **Read**
  - `GET /api/dashboard/repositories/[repositoryId]/work-items` (bulk list)
  - `GET /api/dashboard/work-items/[id]?repositoryId=...` (single fetch)
- **Update fields**
  - `PATCH /api/dashboard/work-items/[id]` (title/description/tags/plannedFiles/assignees/priority/estimate + revision control)
- **Move status**
  - `POST /api/dashboard/work-items/[id]/actions/move`
- **Reparent**
  - Implemented in the service layer; exposed via API parsing helpers and board logic (reparent events exist and are applied client-side).
- **Realtime board updates**
  - `GET /api/dashboard/repositories/[repositoryId]/board/events` supports SSE transport (or JSON snapshot fallback).
  - UI uses this stream to update board state by applying `work_item_events`.
- **Story breakdown**
  - `GET /api/dashboard/work-items/[id]/breakdown?repositoryId=...`
  - `POST /api/dashboard/work-items/[id]/breakdown/runs`
  - `GET /api/dashboard/work-items/[id]/breakdown/runs/[runId]?repositoryId=...`
  - `POST /api/dashboard/work-items/[id]/actions/propose-breakdown`
  - `POST /api/dashboard/work-items/[id]/actions/approve-breakdown`
  - Dashboard bootstrap seeds a published `story-breakdown-planner` workflow with a single `breakdown` node for the default launch path.
  - Async planner launch/result retrieval is contract-focused; orchestration consumption is tracked separately in `#289`.

### Natural end / terminal state
- “Natural end” is currently modeled as status `Done` for all work item types.
- There is no “Cancelled/Won’t do” terminal status and no supported delete/archive flow in the dashboard API.

### Current UI coverage
- `/repositories/[repositoryId]/board`
  - Task kanban flow (drag tasks across task statuses), plus realtime events.
- `/repositories/[repositoryId]/stories`
  - Story list.
- `/repositories/[repositoryId]/stories/[storyId]`
  - Story detail + breakdown proposal inspection and approval interactions.
- Missing UI surfaces for:
  - epics/features (creation, navigation, rollup views)
  - editing story/task fields (title/description/tags/etc.) despite API support
  - an explicit work item event audit log

---

## 5) Workflow trees + draft workflows

### Data model
- `workflow_trees` (versioned; status `draft | published`)
- `tree_nodes`, `tree_edges` (topology for a specific `workflow_tree_id`)
- `prompt_templates`, `guard_definitions` (referenced by nodes/edges)

### Creation
- **Dashboard HTTP API**
  - `POST /api/dashboard/workflows` creates a draft workflow (`status=draft`, `version=1`), optionally seeded from a template.
  - `POST /api/dashboard/workflows/[treeKey]/duplicate` creates a new draft v1 from an existing workflow topology.

### Interaction
- **Catalog/list**
  - `GET /api/dashboard/workflows` (launchable: latest published per treeKey)
  - `GET /api/dashboard/workflows/catalog` (management view: published + draft presence)
- **Draft editing**
  - `GET /api/dashboard/workflows/[treeKey]/draft?version=...` returns an existing draft or bootstraps a new draft from latest published.
  - `PUT /api/dashboard/workflows/[treeKey]/draft?version=...` saves the full draft topology with optimistic draft revision.
    - Save is “replace topology”: nodes/edges/templates/guards are rewritten for the tree version on each save.
- **Validate + publish**
  - `POST /api/dashboard/workflows/[treeKey]/draft/validate?version=...`
  - `POST /api/dashboard/workflows/[treeKey]/draft/publish?version=...`
- **Launch support**
  - `GET /api/dashboard/workflows/[treeKey]/nodes` enumerates published nodes for single-node launch selection.

### Natural end / terminal state
- Draft “ends” by being published (a new immutable published version becomes launchable).
- Published workflow versions are stable snapshots; there is no delete/archive lifecycle today.

### Current UI coverage
- `/workflows`
  - Catalog list, duplicate, navigate to editor, view JSON.
- `/workflows/new`
  - Create new workflow (template choice).
- `/workflows/[treeKey]/edit`
  - Draft editor (save/validate/publish).

---

## 6) Workflow runs + run nodes

### Data model
- `workflow_runs` status ∈ `pending | running | paused | completed | failed | cancelled`
- `run_nodes` status ∈ `pending | running | completed | failed | skipped | cancelled`
- Run inspection tables (surfaced in the dashboard):
  - `run_node_stream_events`, `run_node_diagnostics`, `phase_artifacts`, `routing_decisions`, `run_join_barriers` (fan-out)

### Creation
- **Dashboard HTTP API**
  - `POST /api/dashboard/runs` materializes a new run from a published workflow tree key.
  - Optionally binds a repository context (creating a run worktree) when `repositoryName` is provided.
  - Supports `executionScope` (`full` vs `single_node`) and node selector for `single_node`.
- **CLI**
  - `alphred run --tree <tree_key> [--repo ...] [--branch ...]`

### Interaction
- **List + detail**
  - `GET /api/dashboard/runs?limit=...`
  - `GET /api/dashboard/runs/[runId]` (detail snapshot: nodes, artifacts, routing decisions, diagnostics, worktrees)
- **Lifecycle controls (operator actions)**
  - `POST /api/dashboard/runs/[runId]/actions/[action]` where action ∈ `pause | resume | cancel | retry`
  - These map to core executor lifecycle constraints (invalid transitions throw typed errors).
- **Node streaming + diagnostics**
  - Node stream: `GET /api/dashboard/runs/[runId]/nodes/[runNodeId]/stream` (supports realtime/poll patterns)
  - Failed command output: `GET /api/dashboard/runs/[runId]/nodes/[runNodeId]/diagnostics/[attempt]/commands/[eventIndex]`

### Natural end / terminal state
- Run ends in one of: `completed`, `failed`, `cancelled`.
- Run nodes end in one of: `completed`, `failed`, `skipped`, `cancelled`.
- Retries create new node attempts and can transition a failed run back to `running` (per executor semantics).

### Current UI coverage
- `/runs`
  - Run list, filters, launch form.
- `/runs/[runId]`
  - Run detail timeline + operator control actions.

---

## 7) Run worktrees

### Data model
- `run_worktrees` status ∈ `active | removed`, plus `worktree_path`, `branch`, `commit_hash`, timestamps.

### Creation
- Created when a run is launched with a repository context and the worktree manager successfully provisions a worktree.

### Interaction
- **Dashboard UI**
  - `/runs/[runId]/worktree` provides a run-scoped file explorer and changed-file inspection.
- **Dashboard HTTP API**
  - `GET /api/dashboard/runs/[runId]/worktrees` lists persisted worktrees for the run.

### Natural end / terminal state
- Worktree ends when cleaned up (status transitions to `removed` with `removed_at` set).
- Today, worktree cleanup is an optional run launch flag (`cleanupWorktree`) and is not a prominent dashboard UI affordance.

---

## 8) Gaps (Lifecycle / interaction holes that likely deserve issues)

These are the “missing endpoints / missing UI flows / missing terminal semantics” that show up when tracing each entity from creation → interaction → natural end.

### Repository gaps
- Dashboard has no remove/archive/edit flow.
- Repository removal is blocked once any `run_worktrees` references exist, which makes “natural end” effectively impossible after first run unless we add an archive/soft-delete pattern (or change FK strategy).

### Work item gaps
- Dashboard UI does not clearly expose “create work item” even though the API supports it.
- Dashboard UI does not expose “edit fields” (PATCH) flows for stories/tasks.
- No terminal status besides `Done`; no cancel/close/archive semantics.
- No per-work-item event timeline UI (events exist, but are only consumed implicitly by the board stream).

### Run gaps
- Worktree cleanup is available as an API flag but isn’t surfaced as a first-class operator choice in the UI.
- No “attach run to work item / issue” contract despite branch template support for `{issue-id}` in `@alphred/git`.

---

## 9) Proposed GitHub Issues (actionable backlog)

The list below is intended to be copy-pastable into GitHub issues. Each item calls out the user-facing interaction, the likely API changes, and where it would land in UI.

1. **Dashboard: Add repository archive/remove flow**
   - UI: `/repositories` add actions for archive/remove, and reflect archived status.
   - API: add `DELETE /api/dashboard/repositories/[name]` or `POST .../actions/archive`.
   - Data: prefer “archived” flag over hard-delete to preserve `run_worktrees` history.

2. **DB: Introduce repository archival to unblock “natural end”**
   - Schema: add `repositories.archived_at` (or `status`) and adjust queries to hide archived by default.
   - Keep FK integrity with run/worktree history; avoid blocking cleanup.

3. **Dashboard: Work item create UI (story/task)**
   - UI: add “New story” on `/repositories/[id]/stories` and “New task” on story detail.
   - API: reuse existing `POST /api/dashboard/repositories/[id]/work-items`.

4. **Dashboard: Work item field editor UI (title/description/tags/plannedFiles/assignees/priority/estimate)**
   - UI: edit panel in `/repositories/[id]/stories/[storyId]` and/or board drawer for tasks.
   - API: wire `PATCH /api/dashboard/work-items/[id]` with revision handling.

5. **Dashboard: Work item activity feed**
   - UI: a “History” panel on story detail showing events (created/updated/status changes/breakdown events).
   - API: add `GET /api/dashboard/work-items/[id]/events?repositoryId=...` (paged).

6. **Work item lifecycle: add cancellation/archival semantics**
   - Add `Cancelled` (or `Closed`) to work item statuses and update transition rules.
   - UI: allow cancelling from story/task views; distinguish “Done” vs “Cancelled”.

7. **Run launch: allow associating a run with a work item/issue**
   - API: extend `POST /api/dashboard/runs` with `workItemId` and/or `issueId` and persist association.
   - Git: pass `issue-id` into branch name template context where available.
   - UI: launch from a story page (“Launch run for this story”).

8. **Dashboard: Worktree cleanup option at launch + post-run**
   - UI: toggle “Auto-clean worktree on completion” in run launch form; add “Clean up worktree” on completed run detail.
   - API: reuse existing `cleanupWorktree` launch flag; add explicit cleanup action for existing worktrees.
