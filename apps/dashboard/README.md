# Dashboard API Contracts

This document defines the server API surface exposed by the dashboard integration layer.

Base path: `/api/dashboard`

Related UX planning artifact:
- `apps/dashboard/docs/ux-storyboard.md` (Issue `#95` research, IA, wireframes, and implementation handoff)

## Error Shape

All route-level errors return this envelope:

```json
{
  "error": {
    "code": "invalid_request | not_found | auth_required | conflict | internal_error",
    "message": "human-readable message",
    "details": {}
  }
}
```

Notes:
- `details` is optional and may contain structured data (for example, validation errors) when available.

## Endpoints

### `POST /auth/github/check`

Checks GitHub auth state for dashboard integration calls.

Response `200`:

```json
{
  "authenticated": true,
  "user": "octocat",
  "scopes": ["repo"],
  "error": null
}
```

Type: `DashboardGitHubAuthStatus` (`apps/dashboard/src/server/dashboard-contracts.ts`).

### `GET /repositories`

Lists known repositories.

Response `200`:

```json
{
  "repositories": [
    {
      "id": 1,
      "name": "demo-repo",
      "provider": "github",
      "remoteRef": "octocat/demo-repo",
      "remoteUrl": "https://github.com/octocat/demo-repo.git",
      "defaultBranch": "main",
      "branchTemplate": null,
      "cloneStatus": "cloned",
      "localPath": "/tmp/repos/demo-repo"
    }
  ]
}
```

Type: `{ repositories: DashboardRepositoryState[] }`.

### `POST /repositories`

Registers a GitHub repository in the dashboard registry.

Request body:

```json
{
  "name": "frontend",
  "provider": "github",
  "remoteRef": "octocat/frontend"
}
```

Validation notes:
- Body must be a JSON object.
- `name` is required and must be a string.
- `provider` must be exactly `"github"`.
- `remoteRef` is required and must be a string in `owner/repository` format.
- Duplicate repository names return `409 conflict`.

Response `201`:

```json
{
  "repository": {
    "id": 2,
    "name": "frontend",
    "provider": "github",
    "remoteRef": "octocat/frontend",
    "remoteUrl": "https://github.com/octocat/frontend.git",
    "defaultBranch": "main",
    "branchTemplate": null,
    "cloneStatus": "pending",
    "localPath": null
  }
}
```

Type: `DashboardCreateRepositoryResult`.

### `POST /repositories/[name]/sync`

Triggers repository clone/fetch synchronization for a configured repository.

Response `200`:

```json
{
  "action": "cloned",
  "repository": {
    "id": 1,
    "name": "demo-repo",
    "provider": "github",
    "remoteRef": "octocat/demo-repo",
    "remoteUrl": "https://github.com/octocat/demo-repo.git",
    "defaultBranch": "main",
    "branchTemplate": null,
    "cloneStatus": "cloned",
    "localPath": "/tmp/repos/demo-repo"
  }
}
```

Type: `DashboardRepositorySyncResult`.

### `GET /workflows`

Lists workflow trees available for launch.

Response `200`:

```json
{
  "workflows": [
    {
      "id": 1,
      "treeKey": "demo-tree",
      "version": 1,
      "name": "Demo Tree",
      "description": "Demo tree description"
    }
  ]
}
```

Type: `{ workflows: DashboardWorkflowTreeSummary[] }`.

Notes:
- Only the latest **published** version per `treeKey` is returned.
- Draft workflow versions are not launchable until published.

### `GET /workflows/catalog`

Lists workflow trees for dashboard management, including draft presence.

Response `200`:

```json
{
  "workflows": [
    {
      "treeKey": "demo-tree",
      "name": "Demo Tree",
      "description": "Demo tree description",
      "publishedVersion": 2,
      "draftVersion": 3,
      "updatedAt": "2026-02-21T06:30:50.000Z"
    }
  ]
}
```

Type: `{ workflows: DashboardWorkflowCatalogItem[] }`.

### `POST /workflows`

Creates a new workflow tree as a **draft** v1.

Request body (`DashboardCreateWorkflowRequest`):

```json
{
  "template": "design-implement-review",
  "name": "Design → Implement → Review",
  "treeKey": "design-implement-review",
  "description": "Optional description"
}
```

Validation notes:
- `treeKey` must be lowercase `a-z0-9-` and unique across workflow trees.

Response `201`:

```json
{
  "workflow": {
    "treeKey": "design-implement-review",
    "draftVersion": 1
  }
}
```

Type: `{ workflow: DashboardCreateWorkflowResult }`.

### `POST /workflows/[treeKey]/duplicate`

Duplicates an existing workflow tree into a new **draft** v1.

Notes:
- Copies the latest **draft** topology for `treeKey` when one exists; otherwise copies the latest **published** version.
- The duplicated workflow is always created as `status = 'draft'` and `version = 1`.

Request body (`DashboardDuplicateWorkflowRequest`):

```json
{
  "name": "Design → Implement → Review (Copy)",
  "treeKey": "design-implement-review-copy",
  "description": "Optional description"
}
```

Response `201`:

```json
{
  "workflow": {
    "treeKey": "design-implement-review-copy",
    "draftVersion": 1
  }
}
```

Type: `{ workflow: DashboardDuplicateWorkflowResult }`.

### `GET /workflows/[treeKey]/draft`

Fetches the current draft for a tree key, creating a new draft from the latest published version when needed.

Response `200`:

```json
{
  "draft": {
    "treeKey": "demo-tree",
    "version": 3,
    "draftRevision": 0,
    "name": "Demo Tree",
    "description": null,
    "versionNotes": null,
    "nodes": [],
    "edges": [],
    "initialRunnableNodeKeys": []
  }
}
```

Type: `{ draft: DashboardWorkflowDraftTopology }`.

### `PUT /workflows/[treeKey]/draft?version=<n>`

Saves the draft topology (used by the workflow builder autosave loop).

Notes:
- `draftRevision` must be a positive integer that increases on every save attempt (used for optimistic concurrency).

Request body (`DashboardSaveWorkflowDraftRequest`):

```json
{
  "draftRevision": 1,
  "name": "Demo Tree",
  "description": "Optional description",
  "versionNotes": "Optional version notes",
  "nodes": [],
  "edges": []
}
```

Response `200`:

```json
{
  "draft": {
    "treeKey": "demo-tree",
    "version": 3,
    "draftRevision": 1,
    "name": "Demo Tree",
    "description": null,
    "versionNotes": null,
    "nodes": [],
    "edges": [],
    "initialRunnableNodeKeys": []
  }
}
```

Type: `{ draft: DashboardWorkflowDraftTopology }`.

### `POST /workflows/[treeKey]/draft/validate?version=<n>`

Validates the saved draft and returns errors/warnings that block publishing.

Response `200`:

```json
{
  "result": {
    "errors": [],
    "warnings": [],
    "initialRunnableNodeKeys": ["design"]
  }
}
```

Type: `{ result: DashboardWorkflowValidationResult }`.

### `POST /workflows/[treeKey]/draft/publish?version=<n>`

Publishes a validated draft version.

Request body (`DashboardPublishWorkflowDraftRequest`):

```json
{
  "versionNotes": "Optional notes"
}
```

Response `200`:

```json
{
  "workflow": {
    "id": 1,
    "treeKey": "demo-tree",
    "version": 3,
    "name": "Demo Tree",
    "description": null
  }
}
```

Type: `{ workflow: DashboardWorkflowTreeSummary }`.

### `GET /runs`

Lists run summaries.

Query parameters:
- `limit` (optional): positive integer. Defaults to `20`.

Response `200`:

```json
{
  "runs": [
    {
      "id": 1,
      "tree": {
        "id": 1,
        "treeKey": "demo-tree",
        "version": 1,
        "name": "Demo Tree"
      },
      "repository": {
        "id": 1,
        "name": "demo-repo"
      },
      "status": "completed",
      "startedAt": "2026-02-17T20:01:00.000Z",
      "completedAt": "2026-02-17T20:02:00.000Z",
      "createdAt": "2026-02-17T20:01:00.000Z",
      "nodeSummary": {
        "pending": 0,
        "running": 0,
        "completed": 1,
        "failed": 0,
        "skipped": 0,
        "cancelled": 0
      }
    }
  ]
}
```

Type: `{ runs: DashboardRunSummary[] }`.

Notes:
- `repository` reflects the active run worktree repository when present.
- `repository` is `null` when a run has no associated worktree/repository context.

### `POST /runs`

Launches a workflow run.

Request body (`DashboardRunLaunchRequest`):

```json
{
  "treeKey": "demo-tree",
  "repositoryName": "demo-repo",
  "branch": "feature/my-branch",
  "executionMode": "async",
  "executionScope": "single_node",
  "nodeSelector": {
    "type": "node_key",
    "nodeKey": "design"
  },
  "cleanupWorktree": false
}
```

Validation notes:
- `treeKey` is required and must be a string.
- `repositoryName`, when provided, must be a non-empty string after trimming.
- `branch`, when provided, must be a string.
- `executionMode`, when provided, must be `"async"` or `"sync"`.
- `executionScope`, when provided, must be `"full"` or `"single_node"` (default is `"full"`).
- `nodeSelector`, when provided, requires `executionScope = "single_node"` and must include:
  - `type = "next_runnable"`; or
  - `type = "node_key"` with non-empty `nodeKey`.
- `cleanupWorktree`, when provided, must be a boolean.
- When `cleanupWorktree` is `true`, the service attempts worktree cleanup after workflow execution for both success and failure outcomes once execution starts.

Response:
- `202` when `mode = "async"`
- `200` when `mode = "sync"`
- Async lifecycle semantics after `202`:
  - If detached execution fails before the run starts, the run is marked `cancelled`.
  - If detached execution fails after the run starts, the run is marked `failed`.
  - Terminal status can be observed through `GET /runs` and `GET /runs/[runId]`.

Body type: `DashboardRunLaunchResult`.

### `GET /runs/[runId]`

Gets a detailed run snapshot.

Path parameters:
- `runId`: positive integer.

Response `200`: `DashboardRunDetail`.

Run detail includes:
- `artifacts`: latest artifact previews for run triage.
- `routingDecisions`: latest routing decisions.
- `diagnostics`: persisted per-node/per-attempt diagnostics payloads for post-run inspection (inspection-only, not execution context).
  - Failed command executions can expose `diagnostics[].diagnostics.failedCommandOutputs[]` references with deterministic fetch paths for full command output.

### `POST /runs/[runId]/actions/[action]`

Applies a run lifecycle control action.

Path parameters:
- `runId`: positive integer.
- `action`: one of `cancel`, `pause`, `resume`, `retry`.

Request body:
- None.

Response `200` (`DashboardRunControlResult`):

```json
{
  "action": "pause",
  "outcome": "applied",
  "workflowRunId": 42,
  "previousRunStatus": "running",
  "runStatus": "paused",
  "retriedRunNodeIds": []
}
```

Response semantics:
- `outcome: "applied"` means the control changed persisted lifecycle state.
- `outcome: "noop"` means the requested control was already satisfied and no additional change was required.
- `retriedRunNodeIds` is populated for successful retry controls and empty for non-retry controls/noop retries.

Error semantics:
- `400 invalid_request` for malformed `runId` or unsupported `action`.
- `404 not_found` when `runId` does not exist.
- `409 conflict` for invalid lifecycle transitions, retry-target-not-found, or concurrent control conflicts.
- Conflict responses include `error.details.controlCode` when available from typed runtime control errors.

### `GET /runs/[runId]/nodes/[runNodeId]/stream`

Gets persisted provider stream events for a specific run-node attempt and supports live SSE transport.

Path parameters:
- `runId`: positive integer.
- `runNodeId`: positive integer.

Query parameters:
- `attempt` (required): positive integer run-node attempt.
- `lastEventSequence` (optional): non-negative integer resume pointer.
- `transport` (optional): set to `sse` for live Server-Sent Events.

Snapshot response `200`: `DashboardRunNodeStreamSnapshot`.

SSE transport events (`transport=sse`):
- `stream_event`: one normalized provider event payload.
- `stream_state`: connection and node status updates.
- `stream_end`: terminal closure for the selected node attempt.
- `stream_error`: stream-channel failure details.

### `GET /runs/[runId]/nodes/[runNodeId]/diagnostics/[attempt]/commands/[eventIndex]`

Gets full persisted output for a failed command-execution event within a run-node attempt.

Path parameters:
- `runId`: positive integer.
- `runNodeId`: positive integer.
- `attempt`: positive integer run-node attempt.
- `eventIndex`: non-negative integer diagnostics event index.

Response `200`: full command output payload including:
- `command`, `exitCode`
- non-truncated `output`
- optional `stdout` / `stderr` when available
- `artifactId` and `createdAt` metadata

Error semantics:
- `400 invalid_request` for malformed ids/index values.
- `404 not_found` when run/run-node does not exist or no failed command output was persisted for that attempt + event index.

### `GET /runs/[runId]/worktrees`

Gets worktree metadata for a run.

Path parameters:
- `runId`: positive integer.

Response `200`:

```json
{
  "worktrees": [
    {
      "id": 1,
      "runId": 1,
      "repositoryId": 1,
      "path": "/tmp/worktrees/demo-run-1",
      "branch": "alphred/demo-tree/1",
      "commitHash": "abc1234",
      "status": "active",
      "createdAt": "2026-02-17T20:01:10.000Z",
      "removedAt": null
    }
  ]
}
```

Type: `{ worktrees: DashboardRunWorktreeMetadata[] }`.

## UI Route Notes

### `/runs/[runId]`

- Run detail includes an **Agent stream inspector** for the selected node attempt.
- Inspector workflow:
  - Event list supports event-type filter (`system`, `assistant`, `tool_use`, `tool_result`, `usage`, `result`) and free-text search.
  - Keyboard navigation is supported in the event list (`ArrowUp`, `ArrowDown`, `Home`, `End`).
  - Detail pane supports `Pretty JSON`, `Raw`, and `Rendered Markdown` (when payload appears markdown-like).
  - Utility actions: copy payload, copy metadata, download payload as `.json`, and line-wrap toggle.
- URL query state is synchronized for shareable review links:
  - `streamRunNodeId`
  - `streamAttempt`
  - `streamEventSequence`
- Large event histories use incremental rendering controls (`Load older events`) to keep the inspector responsive.
- Persisted stream payloads are inspection-safe previews (`contentPreview` + metadata); when preview text is shorter than `contentChars`, the UI marks the payload as truncated.

### `/runs/[runId]/worktree`

- The page loads persisted run detail first via dashboard service APIs.
- If persisted run detail is not found, the page falls back to fixture-backed previews for known fixture run IDs.
- Both persisted and fixture-backed runs use a split-pane explorer: left file tree, right preview.
- Default file selection prioritizes the first changed file, then falls back to the first tracked file.
- Preview supports `view=diff` and `view=content` modes while preserving `path` deep links.
- Changed-file emphasis is always visible in tree entries.
- If selected-path preview retrieval fails, the page shows an in-context retry action for that path.
- Performance envelope for medium repositories:
  - Up to ~2,500 tracked paths should remain interactive for server-rendered tree loading.
  - Diff and content preview panes are truncated at 14,000 characters.
  - Content reads are capped at 96,000 bytes per selected file before truncation messaging.

## Source of Truth

Canonical payload types live in:
- `apps/dashboard/src/server/dashboard-contracts.ts`

Route handlers live in:
- `apps/dashboard/app/api/dashboard/**/route.ts`

Error mapping lives in:
- `apps/dashboard/src/server/dashboard-errors.ts`
