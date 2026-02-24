# Issue 169 Design: Replace Run Fixtures with Backend Data

- Issue: https://github.com/hansjm10/alphred/issues/169
- Repository: `hansjm10/alphred`
- Drafted: February 24, 2026
- Source retrieval: `gh api repos/hansjm10/alphred/issues/169` and `gh api repos/hansjm10/alphred/issues/169/comments --paginate` (no comments at draft time)

## Context

Run-facing dashboard pages currently depend on `RUN_ROUTE_FIXTURES` in `apps/dashboard/app/runs/run-route-fixtures.ts`.  
The backend already provides persisted run data through dashboard service methods and API routes:

- `listWorkflowRuns`
- `getWorkflowRunDetail`
- `getRunWorktrees`
- `GET /api/dashboard/runs`
- `GET /api/dashboard/runs/[runId]`
- `GET /api/dashboard/runs/[runId]/worktrees`

Issue #169 requires replacing fixture-backed primary page content with real backend data on:

- `/`
- `/runs`
- `/runs/[runId]`
- `/runs/[runId]/worktree`

## Logical Requirements

### Explicit Requirements (from issue)

1. Add server loaders for run list and run detail/worktree data.
2. Refactor run-facing pages to consume loader data instead of fixtures.
3. Add mapping/view-model helpers between dashboard contracts and route UI models.
4. Expand status handling to include backend statuses that are currently missing (`cancelled`, `skipped`).
5. Update route/page tests to mock loader/service data, not hardcoded fixtures.
6. Remove fixture module, or reduce it to route utility helpers only.

### Acceptance Criteria (from issue)

1. `/`, `/runs`, `/runs/[runId]`, `/runs/[runId]/worktree` no longer depend on fixture data for primary content.
2. Run pages render persisted runs correctly across terminal and non-terminal statuses.
3. Status UI supports backend statuses including `cancelled` and `skipped`.
4. Existing route/page tests are updated and passing.
5. Fixture module is removed or reduced to route utility helpers only.

### Derived Requirements (implementation-critical)

1. Run detail and worktree loaders must map backend `not_found` errors to Next `notFound()` for route parity.
2. Loader calls should use server-side `createDashboardService()` directly (consistent with existing repository/auth loaders).
3. Route utilities (href building, status filter normalization) must remain stable so existing deep links continue to work where still relevant.
4. UI copy/structure must adapt where backend contract does not provide fixture-era fields (notably file-diff payloads and explicit repository labels on summaries).

## Current State (Code)

- Fixture data + helpers:
  - `apps/dashboard/app/runs/run-route-fixtures.ts`
- Fixture-backed run pages:
  - `apps/dashboard/app/page.tsx`
  - `apps/dashboard/app/runs/page.tsx`
  - `apps/dashboard/app/runs/[runId]/page.tsx`
  - `apps/dashboard/app/runs/[runId]/worktree/page.tsx`
- Status badge only supports:
  - `pending | running | completed | failed | paused`
  - (`apps/dashboard/app/ui/primitives.tsx`)

Backend contract already supports:

- Run status: `pending | running | paused | completed | failed | cancelled`
- Node status: `pending | running | completed | failed | skipped | cancelled`
- (`apps/dashboard/src/server/dashboard-contracts.ts`)

## Proposed Design

### 1. Add Run Loader Layer (Server-only, cached)

Create loaders following existing patterns (`cache(async () => ...)`) already used by repositories/auth.

Planned files:

- `apps/dashboard/app/runs/load-dashboard-runs.ts`
  - wraps `service.listWorkflowRuns(limit)`
- `apps/dashboard/app/runs/[runId]/load-dashboard-run-detail.ts`
  - wraps `service.getWorkflowRunDetail(runId)`
- `apps/dashboard/app/runs/[runId]/worktree/load-dashboard-run-worktrees.ts`
  - wraps `service.getRunWorktrees(runId)` or reuses detail loader worktrees

Error behavior:

- For route IDs:
  - invalid runId => `notFound()`
  - backend `not_found` => `notFound()`
- Other errors:
  - rethrow so route `error.tsx` boundaries handle failures

### 2. Add View-Model Mapping Helpers

Create `apps/dashboard/app/runs/run-view-models.ts` to isolate UI shaping from contract payloads.

Responsibilities:

1. Convert `DashboardRunSummary` to run-list/home cards.
2. Convert `DashboardRunDetail` to run-detail sections:
   - summary rows
   - node status list
   - artifacts/routing decision presentation
3. Convert `DashboardRunWorktreeMetadata[]` to worktree page presentation rows.
4. Normalize timestamp rendering for UI labels (single formatting strategy in one place).

Rationale:

- Keeps pages declarative.
- Prevents contract-to-UI mapping duplication across four routes.
- Makes test inputs deterministic by unit-testing mapping functions.

### 3. Split Fixture Module into Route Utilities + Remove Data

Replace `run-route-fixtures.ts` with a utility-focused module (name can stay or be renamed to `run-route-utils.ts`) containing only:

- `normalizeRunFilter`
- `resolveRunFilterHref`
- `buildRunDetailHref`
- `buildRunWorktreeHref`

Remove fixture records and fixture-only selectors (`RUN_ROUTE_FIXTURES`, `findRunByParam`, fixture worktree path resolver).

### 4. Route-by-Route Data Flow

#### `/` (`apps/dashboard/app/page.tsx`)

1. Load run summaries (bounded limit, e.g. 20).
2. Derive active runs from persisted statuses (`running`, `paused`).
3. Render links/status from mapped summaries instead of fixture records.

#### `/runs` (`apps/dashboard/app/runs/page.tsx`)

1. Load persisted run summaries from loader.
2. Apply existing query filter UX (`all`, `running`, `failed`) against real data.
3. Render totals from loaded data, not fixture array length.

#### `/runs/[runId]` (`apps/dashboard/app/runs/[runId]/page.tsx`)

1. Load persisted run detail by `runId`.
2. Render summary/status from detail payload.
3. Render nodes/artifacts/routing decisions from backend snapshots.
4. Keep CTA behavior status-aware; add safe handling for `cancelled`.

#### `/runs/[runId]/worktree` (`apps/dashboard/app/runs/[runId]/worktree/page.tsx`)

Current UX is file-diff-centric, but backend only returns worktree metadata.  
For issue #169, ship a metadata-first version:

1. Render worktree entries (path, branch, status, commit hash, timestamps).
2. Show explicit informational notice that file diff content is not yet available from backend contract.
3. Keep route functional and data-backed without synthetic diffs.

This resolves the issue’s follow-up question by unblocking now without fabricating unavailable data.

### 5. Expand Status UI Coverage

Update status components/styles to include missing backend statuses:

- `apps/dashboard/app/ui/primitives.tsx`
  - extend `StatusVariant` with `cancelled` and `skipped`
  - add label/icon mapping
- `apps/dashboard/app/globals.css`
  - add `.status-badge--cancelled`
  - add `.status-badge--skipped`

Usage mapping rules:

- Run-level badges: support `cancelled`
- Node-level badges: support `skipped` and `cancelled`

### 6. Testing Strategy

Convert run route tests from fixture-coupled to loader/mapping-coupled.

Primary test updates:

- `apps/dashboard/app/page.test.tsx`
- `apps/dashboard/app/runs/page.test.tsx`
- `apps/dashboard/app/runs/[runId]/page.test.tsx`
- `apps/dashboard/app/runs/[runId]/worktree/page.test.tsx`
- `apps/dashboard/app/ui/primitives.test.tsx`

Fixture test changes:

- Replace `run-route-fixtures.test.ts` with utility and/or view-model tests.

Test approach:

1. Mock loader modules (not fixture arrays).
2. Assert rendering for mixed statuses including `cancelled` and `skipped`.
3. Assert `notFound()` behavior for invalid/missing run IDs.
4. Assert metadata-first worktree presentation and empty-state behavior.

## Implementation Plan

1. Create loaders and run view-model module.
2. Refactor `/`, `/runs`, `/runs/[runId]`, `/runs/[runId]/worktree` to consume loader + mapped models.
3. Remove fixture records and keep only route utility helpers.
4. Expand `StatusBadge` variants and CSS classes.
5. Rewrite run page tests to use loader mocks and persisted-shape fixtures.
6. Run dashboard tests and monorepo type/lint gates.

## Risks and Mitigations

1. Contract mismatch on worktree diff content.
   - Mitigation: metadata-first UX with explicit copy; no synthetic diffs.
2. Test churn from fixture-heavy assertions.
   - Mitigation: stabilize around loader contracts + dedicated view-model tests.
3. Missing repository label in run summary contract for list pages.
   - Mitigation: render workflow/tree metadata and timestamps from persisted summary contract; do not invent repository names.

## Out of Scope

1. Adding new backend endpoints for changed-file or diff payloads.
2. Introducing client-side polling/streaming for live run updates.
3. Expanding `/runs` tab model beyond current filters unless separately requested.

## Acceptance Mapping

1. No fixture dependency on run-facing pages:
   - achieved by loader-based page data + fixture record removal.
2. Correct rendering across run statuses:
   - achieved by direct contract mapping + status extension.
3. `cancelled` and `skipped` support:
   - achieved via `StatusBadge` variant + CSS updates.
4. Updated and passing tests:
   - achieved via loader-mock test rewrite and utility/view-model tests.
5. Fixture module removed/shrunk:
   - achieved by data removal and retention of route utility helpers only.
