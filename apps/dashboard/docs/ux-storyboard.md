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

## 1.1 Key Concepts (New-User Glossary)

- Repository:
  - A source code repo managed by Alphred for dashboard-driven runs.
- Run:
  - One execution instance of a workflow tree on a selected repository context.
- Node:
  - A single phase inside a run (for example design/implement/review); each node has its own lifecycle state.
- Timeline event:
  - A timestamped activity emitted during run execution (status changes, tool events, result events).
- Worktree:
  - The isolated run-linked filesystem snapshot used for code changes and artifact inspection.
- Readiness:
  - The minimum conditions for running safely: valid auth + syncable/cloned repository.

Operator quick-start sequence:
1. Check auth on Integrations.
2. Sync/select repository on Repositories.
3. Launch from Runs or Overview.
4. Monitor run in Run Detail.
5. Inspect changed files in Run Worktree.

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

User actions and visible cues:
- Action: user clicks `Check Auth`.
- Cues:
  - `checking`: spinner + disabled mutation CTAs.
  - `authenticated`: green status badge + run/repo CTAs enabled.
  - `unauthenticated` or `auth_error`: warning/error badge + inline remediation commands.

### Journey B (P0): Select/sync repository
Start: user has or adds a repository.
End: repo is in `cloned` state and selectable for runs.

State transitions:
- repo_pending -> sync_in_progress -> cloned
- repo_pending -> sync_in_progress -> sync_error -> retry

Primary surfaces:
- Repositories list + detail drawer/panel

User actions and visible cues:
- Action: user clicks `Sync` on a repository row.
- Cues:
  - `sync_in_progress`: row spinner and action disabled.
  - `cloned`: success badge + local path shown.
  - `sync_error`: error badge + `Retry` action + remediation hint.

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

User actions and visible cues:
- Action: user clicks `Launch Run`.
- Cues:
  - `run_pending`: new row appears with queued badge.
  - `run_running`: active badge + elapsed timer + timeline stream.
  - terminal (`completed`/`failed`): terminal badge + artifact/worktree affordance.

### Journey D (P1): Inspect worktree artifacts
Start: user opens run worktree view.
End: user can browse changed files and preview content.

State transitions:
- loading_tree -> tree_loaded
- tree_loaded -> file_selected
- tree_loaded -> load_error -> retry

Primary surfaces:
- Worktree explorer split view

User actions and visible cues:
- Action: user opens `Open Worktree` from run detail.
- Cues:
  - `loading_tree`: tree and preview skeletons.
  - `tree_loaded`: changed-file markers visible in tree.
  - `load_error`: scoped error for the requested path with local retry.

## 4) Information Architecture and Navigation Model

Top-level routes:
- `/` Overview: health snapshot + active runs + action shortcuts.
- `/repositories` Repo registry, sync controls, clone status.
- `/runs` Run table and quick filters.
- `/runs/[runId]` Run detail timeline, node statuses, artifacts, worktrees.
- `/runs/[runId]/worktree` File explorer scoped to run.
- `/settings/integrations` Auth state and remediation actions.

### 4.1 Route Contract Matrix

| Route | Purpose | Required states |
| --- | --- | --- |
| `/` | Overview snapshot with active-run CTA entry points | loading, error, empty, active |
| `/repositories` | Repository registry and sync actions | loading, error, empty, list |
| `/runs` | Run list with status filter tabs | loading, error, empty, list |
| `/runs/[runId]` | Run detail timeline, node status, artifacts | loading, error, not-found, detail |
| `/runs/[runId]/worktree` | Run-scoped changed-file explorer | loading, error, not-found, empty-files, detail |
| `/settings/integrations` | Integration/auth status and remediation actions | loading, error, empty, configured |

### 4.2 Query Parameter Contract

- `/runs?status=<value>`
  - Supported values: `running`, `failed`.
  - Unsupported or missing values resolve to `all`.
  - Repeated values use the first value.
- `/runs/[runId]/worktree?path=<file-path>`
  - If `path` matches a tracked worktree file, that file is selected.
  - If `path` is missing or unsupported, selection falls back to the first tracked file.
  - Repeated values use the first value before fallback rules are applied.

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
| Alphred  [Overview] [Repositories] [Runs] [Integrations]             Auth: OK |
+-------------------------+------------------------------------------------------+
| Left rail nav           | Page title                             Quick actions |
| - Overview              |------------------------------------------------------|
| - Repositories          | Content region                                         |
| - Runs                  |                                                      |
| - Integrations          |                                                      |
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

Legend:
- `*` means the file changed during this run.
- Default selection is first changed file.
- Preview pane supports toggle between diff and content view.

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

Concrete style specification for implementation:

- Typography scale:
  - `h1` `32/40` `Space Grotesk 700`
  - `h2` `24/32` `Space Grotesk 600`
  - `h3` `20/28` `Space Grotesk 600`
  - body default `16/24` `Source Sans 3 400`
  - body compact `14/20` `Source Sans 3 400`
  - data labels/table cells `13/20` `IBM Plex Mono 400` with `font-variant-numeric: tabular-nums`
- Core color tokens:
  - `--bg-canvas: #F6F8FB`
  - `--bg-surface: #FFFFFF`
  - `--bg-subtle: #EEF2F6`
  - `--border-default: #D0D7E2`
  - `--text-primary: #1F2937`
  - `--text-secondary: #4B5565`
  - `--text-muted: #6B7280`
  - `--accent-active: #1F75CB`
  - `--accent-info: #005D5D`
  - `--accent-success: #198038`
  - `--accent-warning: #8E6400`
  - `--accent-danger: #DA1E28`
- Accessibility baseline:
  - Ensure normal text contrast >= `4.5:1` and non-text UI contrast >= `3:1`.
  - Current token checks pass for default text/accent pairs used in badges and controls.
- Layout and spacing:
  - Use `8px` base spacing scale (`8, 12, 16, 24, 32, 40, 48`).
  - Desktop shell: `240px` left rail + fluid content.
  - Content max width `1440px`; card gap `16px`; panel internal padding `16px`.
  - Grid: 12 columns desktop, 4 columns mobile.
- Status and data-viz semantics:
  - `running` -> `--accent-active`
  - `completed` -> `--accent-success`
  - `failed` -> `--accent-danger`
  - `paused` -> `--accent-warning`
  - `pending` -> neutral border + icon
  - Never communicate state with color alone; always pair with text/icon shape.
- Motion:
  - `150ms` for micro-interactions (hover, focus, badge updates).
  - `240ms` for panel reveal and route-level content transitions.
  - Easing: standard accelerate/decelerate cubic-bezier curves from Carbon motion guidance.
- Chart palette (ordered):
  - `#1F75CB`, `#005D5D`, `#198038`, `#8E6400`, `#DA1E28`, `#6929C4`
  - Reserve red/green for status-critical meaning and avoid red-vs-green-only comparisons.

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

## 11) Web Research Inputs (2026-02-18)

Sources used to ground style decisions:
- Grafana dashboard design best practices:
  - https://grafana.com/docs/grafana/latest/dashboards/build-dashboards/best-practices/
  - Used for narrative-first dashboard structure and reducing panel noise.
- GitLab Pajamas dashboard pattern:
  - https://design.gitlab.com/patterns/dashboards/
  - Used for block hierarchy and widget organization.
- GitLab data visualization color guidance:
  - https://design.gitlab.com/data-visualization/color
  - Used for semantic color mapping and avoiding red/green ambiguity.
- USWDS data visualization guidance:
  - https://designsystem.digital.gov/components/data-visualization/
  - Used for clear legends, data labels, and color restraint in charts.
- W3C WCAG 2.2 minimum contrast:
  - https://www.w3.org/TR/WCAG22/#contrast-minimum
  - Used as accessibility threshold for text contrast.
- W3C WCAG 2.2 non-text contrast:
  - https://www.w3.org/TR/WCAG22/#non-text-contrast
  - Used for borders, focus rings, and interactive control contrast.
- GitHub Primer primitives:
  - https://primer.style/primitives/colors
  - Used as reference model for structured color token scales.
- IBM Carbon data visualization palettes:
  - https://carbondesignsystem.com/data-visualization/color-palettes/
  - Used for category palette ordering and semantic color consistency.
- IBM Carbon motion:
  - https://carbondesignsystem.com/elements/motion/overview/
  - Used for practical motion-duration defaults.
- Typeface references:
  - Space Grotesk: https://floriankarsten.com/typefaces/space-grotesk
  - Source Sans 3: https://github.com/adobe-fonts/source-sans

## 12) UX Clarity Model (Operator Mental Model)

This product is easiest to understand when the UI reinforces one core sequence:

1. Verify readiness (auth + repository clone state).
2. Launch a run.
3. Monitor run progress.
4. Inspect run outputs/worktree.
5. Recover from failures.

Clarity rules used across screens:
- A run is the primary unit of work; all deep investigation is run-scoped.
- Worktree is not a top-level domain; it is a run-detail sub-surface.
- Each screen has exactly one primary CTA.
- Every blocked action must explain why and what to do next.
- Every async surface must show last-updated timestamp and stale/reconnecting status.
- Status text, icon, and color are always shown together.
- Timeline and status badges use the same status vocabulary everywhere.

## 13) Per-Screen Interaction Specification

### 13.1 Overview (`/`)

Primary user question:
- Is the system ready, and what needs my attention now?

Primary CTA:
- `Launch Run` when readiness is met.
- Fallback CTA becomes `Connect GitHub` or `Sync Repository` when blocked.

Content order:
1. Global readiness card (auth state, repo readiness, backend health).
2. Active runs list (running/paused first).
3. Blockers card (auth errors, failed syncs, failed runs).
4. Recent completed runs (collapsed by default).

Interactions:
- Clicking an active run opens `/runs/[runId]`.
- Clicking blocker opens the remediation route directly:
  - auth blocker -> `/settings/integrations`
  - repo blocker -> `/repositories`
  - run blocker -> `/runs/[runId]`

State behavior:
- Loading: skeleton cards and disabled CTA.
- Empty: onboarding copy with two actions (`Connect GitHub`, `Go to Repositories`).
- Error: retry + diagnostics link; preserve last known snapshot if available.
- Error remediation path (explicit):
  1. Check auth state from the global status strip.
  2. If auth is degraded, open `/settings/integrations` and run `Check Auth`.
  3. Return to Overview and retry data load.

### 13.2 Repositories (`/repositories`)

Primary user question:
- Can I launch from this repo, and if not, how do I fix it?

Primary CTA:
- `Sync` (per-row) or `Add Repository` (global when none exist).

Content structure:
1. Filter/search row.
2. Repository table (name, provider, clone status, local path, last sync, actions).
3. Side panel for selected repository details and remediation notes.

Interactions:
- Row select opens details panel without route jump.
- `Sync` triggers in-row progress state and disables duplicate sync clicks.
- `Retry` appears only for `error` status.
- Selecting a `cloned` repository enables `Launch Run with this repo`.

State behavior:
- Loading: table skeleton.
- Empty: callout with `Add Repository`.
- Error: banner with retry and persistent last successful list (if cached).

### 13.3 Runs List (`/runs`)

Primary user question:
- What is currently running, what failed, and what should I open first?

Primary CTA:
- `Launch Run`.

Content structure:
1. Filter bar (`status`, `workflow`, `repository`, time window).
2. Sorted run table (running first, then failed, then recent completed).
3. Compact KPI strip (active count, failures in 24h, median duration).

Interactions:
- Row click opens `/runs/[runId]`.
- Filters update URL query params for shareable deep links.
- Running rows display live-updating elapsed duration.

State behavior:
- Loading: skeleton rows.
- Empty: explain no runs found for filters and provide `Clear Filters`.
- Error: retry and keep prior filter state.

### 13.4 Run Detail (`/runs/[runId]`)

Primary user question:
- Where is this run in the lifecycle, and what changed recently?

Primary CTA:
- Contextual:
  - running: `Pause` (if available)
  - paused: `Resume`
  - failed: `Retry Failed Node` (if supported)
  - completed: `Open Worktree`

Content structure:
1. Header summary (run status, workflow, repo, started/completed timestamps).
2. Split body:
  - left: timeline/events
  - right: node lifecycle panel
3. Bottom section: artifacts and routing decisions.

Interactions:
- Selecting a timeline event highlights related node.
- Selecting a node filters timeline to that node.
- `Open Worktree` navigates to `/runs/[runId]/worktree`.

State behavior:
- Loading: preserve header shell, skeleton body.
- Error: show if run could not be loaded vs events stream failed.
- Stale stream: non-blocking warning with reconnect countdown.

Realtime channel semantics:
- `Live`
  - Meaning: Active run detail is refreshing on schedule.
  - Default cadence: poll every `4s`.
- `Reconnecting`
  - Meaning: A refresh attempt failed and retry is scheduled.
  - Behavior: retry delay uses bounded exponential backoff.
- `Stale`
  - Meaning: No successful refresh within `15s` while run remains active.
  - Behavior: preserve visible run context and show reconnect countdown.
- `Idle`
  - Meaning: Realtime updates are paused because the run is terminal or realtime is disabled.
  - Behavior: no retry countdown and no degraded warning banner.

Realtime thresholds:
- Base interval: `4s`.
- Backoff cap: `20s`.
- Stale threshold: `15s` since the last successful refresh.

### 13.5 Run Worktree (`/runs/[runId]/worktree`)

Primary user question:
- Which files changed, and what is the impact?

Primary CTA:
- `View Diff` for selected file (or `Open Raw` if non-text).

Content structure:
1. Top bar (run reference, branch, changed-file count, search path).
2. Split view:
  - left: tree with changed-file badges
  - right: preview pane (diff/content/metadata)

Interactions:
- Default selection is first changed file.
- Tree supports keyboard navigation and lazy expansion.
- Preview toggles between unified diff and rendered/plain content.

State behavior:
- Loading: tree + preview skeletons.
- Empty: explicit message when no changed files exist.
- Error: path-scoped retry (do not reload entire page by default).

### 13.6 Integrations (`/settings/integrations`)

Primary user question:
- Is auth valid, and how do I fix it fast if not?

Primary CTA:
- `Check Auth`.

Content structure:
1. GitHub auth status card.
2. Scope/identity details when authenticated.
3. Remediation panel with command snippets when unauthenticated/error.

Interactions:
- `Check Auth` refreshes status and timestamp.
- Copy actions for remediation commands.
- Success state links back to `/repositories` and `/runs`.

State behavior:
- Loading: spinner in status card only.
- Error: diagnostic message + retry.

Auth gate contract matrix:

| Auth gate state | Badge label | Run/Repo mutation actions | Remediation panel | Integration CTA |
| --- | --- | --- | --- | --- |
| `checking` | `Checking` | Disabled | Hidden | `Check Auth` disabled while request in flight |
| `authenticated` | `Authenticated` | Enabled | Hidden | `Check Auth` available; links to repos/runs visible |
| `unauthenticated` | `Unauthenticated` | Blocked | Visible with `gh auth login` and token env command | `Check Auth` available |
| `auth_error` | `Auth check failed` | Blocked | Visible with `gh auth login` and token env command | `Check Auth` available |

## 14) Interaction Acceptance Checks

Use these checks during `#96` and `#97` implementation reviews:

1. User can identify readiness blockers from Overview in under one screen view.
2. Every page has exactly one primary CTA with clear preconditions.
3. Any blocked action provides remediation in the same interaction context.
4. Run detail always answers:
   - current status
   - latest event
   - next likely operator action
5. Worktree page defaults to changed files, not full repository noise.
6. Route transitions preserve context (filters, selected run, selected file path).
7. Loading, empty, error states are distinct and action-oriented on every top-level route.
