# Dashboard UX Research + Storyboard (Issue #95)

Status: Draft ready for implementation handoff
Date: 2026-02-18
Related: #94, #95, #96, #97, #98, #99, #100, #101, #102, #103, #104

## 1) Objective and Constraints

### Objective
Define a creative, operator-friendly dashboard UX before page-level implementation so downstream issues can build against a shared direction.

### Hard constraints (from existing design/docs)
- Runtime semantics and data lifecycle come from `DESIGN.md`.
- Dashboard integrations must use existing package capabilities and contracts (implemented in `#104`) rather than re-implementing core logic.
- API surface currently available is documented in `apps/dashboard/README.md` under `/api/dashboard/*`.
- This issue delivers design artifacts and decisions, not full UI implementation.

### Scope boundary
In scope: user journeys, IA, low-fidelity wireframes, visual direction decision, implementation handoff.
Out of scope: final component implementation, final brand polish, backend feature additions.

## 2) Operator Jobs-to-be-Done

1. Verify environment is ready (GitHub auth, repo visibility).
2. Select and sync a repository.
3. Launch a run with predictable inputs.
4. Monitor run/node progress with minimal ambiguity.
5. Inspect worktree outputs and changed files.
6. Recover quickly from auth/sync/run failures.

## 3) Prioritized User Journeys

### Journey A (P0): Connect GitHub and unlock actions
Start: user opens dashboard with unknown auth state.
End: auth status is known and repo/run actions are gated correctly.

State transitions:
- unknown -> checking -> authenticated
- unknown -> checking -> unauthenticated
- unknown -> checking -> auth_error

Primary surfaces:
- Overview route auth banner
- Settings/Integrations route

### Journey B (P0): Select/sync repository
Start: user has or adds a repository.
End: repo is in `cloned` state and selectable for runs.

State transitions:
- repo_pending -> sync_in_progress -> cloned
- repo_pending -> sync_in_progress -> sync_error -> retry

Primary surfaces:
- Repositories list + detail drawer/panel

### Journey C (P0): Launch run and monitor lifecycle
Start: user selects workflow/repo and launches run.
End: run reaches terminal state and details are explorable.

State transitions:
- run_pending -> run_running -> completed
- run_pending -> run_running -> failed
- run_running -> paused -> running

Primary surfaces:
- Runs list
- Run detail timeline

### Journey D (P1): Inspect worktree artifacts
Start: user opens run worktree view.
End: user can browse changed files and preview content.

State transitions:
- loading_tree -> tree_loaded
- tree_loaded -> file_selected
- tree_loaded -> load_error -> retry

Primary surfaces:
- Worktree explorer split view

## 4) Information Architecture and Navigation Model

Top-level routes:
- `/` Overview: health snapshot + active runs + action shortcuts.
- `/repositories` Repo registry, sync controls, clone status.
- `/runs` Run table and quick filters.
- `/runs/[runId]` Run detail timeline, node statuses, artifacts, worktrees.
- `/runs/[runId]/worktree` File explorer scoped to run.
- `/settings/integrations` Auth state and remediation actions.

Navigation pattern:
- Persistent left rail for primary areas.
- Sticky top bar for run context, global status, and quick actions.
- Route-level loading/error/empty states with consistent shell semantics.

Deep-link model:
- Run-centric links are canonical (`/runs/[runId]`).
- Worktree exploration hangs off run context (`/runs/[runId]/worktree?path=...`).

## 5) Low-Fidelity Storyboard Wireframes

### Global shell

```text
+--------------------------------------------------------------------------------+
| Alphred  [Overview] [Repositories] [Runs] [Worktree] [Settings]      Auth: OK |
+-------------------------+------------------------------------------------------+
| Left rail nav           | Page title                             Quick actions |
| - Overview              |------------------------------------------------------|
| - Repositories          | Content region                                         |
| - Runs                  |                                                      |
| - Settings              |                                                      |
+-------------------------+------------------------------------------------------+
```

### Overview states

Empty state:

```text
+-------------------------------- Overview --------------------------------------+
| No active runs                                                                 |
| Connect GitHub, sync a repository, and launch your first run.                 |
| [Check Auth] [Go to Repositories]                                              |
+--------------------------------------------------------------------------------+
```

Loading state:

```text
+-------------------------------- Overview --------------------------------------+
| Loading run telemetry...                                                       |
| [skeleton cards x3]                                                            |
+--------------------------------------------------------------------------------+
```

Active state:

```text
+-------------------------------- Overview --------------------------------------+
| Active Runs (2)               | GitHub Auth: Authenticated                    |
| run #412  running  node 3/8   | Repo Sync Queue: 1                            |
| run #411  paused   node 4/8   | Last failure: none                            |
+--------------------------------------------------------------------------------+
```

Error state:

```text
+-------------------------------- Overview --------------------------------------+
| Unable to load run summaries.                                                  |
| Reason: backend unavailable / malformed response                               |
| [Retry] [Open diagnostics]                                                     |
+--------------------------------------------------------------------------------+
```

### Repositories states

```text
+------------------------------ Repositories ------------------------------------+
| Search repos... [_____]                                             [Add Repo] |
|------------------------------------------------------------------------------  |
| demo-repo      cloned      /tmp/repos/demo-repo                    [Sync]      |
| sample-repo    error       clone failed: auth denied               [Retry]     |
| new-repo       pending     never synced                            [Sync]      |
+--------------------------------------------------------------------------------+
```

### Runs + Run detail states

```text
+----------------------------------- Runs ---------------------------------------+
| Filters: [status] [workflow] [repo]                                [Launch Run]|
| #412 running    Demo Tree    started 2m ago                         [Open]      |
| #411 completed  Demo Tree    completed 8m ago                       [Open]      |
+--------------------------------------------------------------------------------+
```

```text
+------------------------------- Run #412 ---------------------------------------+
| Status: running   Workflow: demo-tree   Repo: demo-repo                       |
|------------------------------------------------------------------------------  |
| Timeline                                 | Node status                         |
| 20:03 run started                        | design      completed               |
| 20:04 implement running                  | implement   running                 |
| 20:05 tool_use: gh api ...               | review      pending                 |
| ...                                      |                                     |
+--------------------------------------------------------------------------------+
```

### Worktree explorer states

```text
+---------------------------- Run #412 Worktree ---------------------------------+
| Changed files: 5      Branch: alphred/demo-tree/412                            |
|------------------------------------------------------------------------------  |
| file tree                      | preview                                        |
| src/core/engine.ts *           | diff/contents                                  |
| src/ui/panel.tsx *             |                                                |
| README.md                      |                                                |
+--------------------------------------------------------------------------------+
```

## 6) Visual Direction Options

### Option A: Signal Grid (selected)
Design intent: operational cockpit; dense but legible; high signal-to-noise.

- Typography:
  - Display/UI: `Space Grotesk`
  - Body: `Source Sans 3`
  - Data/monospace: `IBM Plex Mono`
- Color system:
  - Base: graphite/stone neutrals.
  - Semantic accents: teal (healthy), amber (attention), red (failure), blue (active).
- Component tone:
  - Rectilinear cards, clear borders, subtle depth.
  - Strong status badges and timeline markers.
- Why selected:
  - Best match for run-state scanning, failure triage, and long-session operator use.

### Option B: Canvas Flow
Design intent: editorial and spacious, emphasizing storytelling over dense ops data.

- Typography:
  - Display/UI: `Fraunces`
  - Body: `Manrope`
  - Data/monospace: `JetBrains Mono`
- Color system:
  - Warm paper-like base with bold sectional color bands.
- Component tone:
  - Larger cards, softer edges, more white space.
- Why not selected:
  - Looks distinctive but lowers information density and slows incident-style scanning.

## 7) Decision Handoff to Implementation Issues

- `#96` Design system + shell:
  - Implement persistent left rail + top status bar shell.
  - Standardize status badge variants (`pending`, `running`, `completed`, `failed`, `paused`).
  - Centralize typography/color/spacing/motion tokens from Option A.
- `#97` IA and routing:
  - Implement route map in section 4 exactly; include route-level loading/error states.
- `#98` auth UX:
  - Gate run/repo mutations when auth is `unauthenticated` or `auth_error`.
  - Show direct remediation text (`gh auth login`, token env guidance).
- `#99` repo onboarding:
  - Repositories list must expose clone lifecycle and retry affordance.
- `#100` run control/lifecycle:
  - Launch form defaults to safe async mode; block invalid actions for active/terminal states.
- `#101` realtime timeline:
  - Timeline panel is first-class in run detail; reconnect and stale-state handling required.
- `#102` worktree explorer:
  - Split-pane tree/preview model with changed-file emphasis.
- `#103` e2e gate:
  - Happy path must follow Journey A -> B -> C -> D and include failure variants.

## 8) Risks and Mitigations

- Risk: API contract gaps for desired UI depth.
  - Mitigation: treat `apps/dashboard/README.md` as contract baseline; file follow-up API issues instead of bypassing contracts.
- Risk: Realtime complexity delays timeline UX.
  - Mitigation: design and test with bounded polling fallback.
- Risk: Worktree explorer performance on medium repos.
  - Mitigation: lazy tree expansion and path-scoped fetches.

## 9) Test Coverage Guidance

Unit/integration focus by issue:
- `#96`: shell semantics, nav landmarks, active-route indication.
- `#97`: route rendering + loading/error/not-found behavior.
- `#98`: auth gating state matrix.
- `#99`: sync happy/failure + retry behavior.
- `#100`: launch validation + lifecycle state rendering.
- `#101`: realtime update/reconnect behavior.
- `#102`: file tree selection, changed-file emphasis, preview fallbacks.
- `#103`: e2e flow across A->B->C->D plus auth/sync failures.

## 10) Explicit Deviations and Follow-Ups

- Deviation from epic sequence: `#104` is already closed before `#95`. This storyboard assumes `#104` contracts as the integration baseline.
- Follow-up needed if contracts are insufficient: open targeted API extension issues rather than expanding scope of `#95`.
