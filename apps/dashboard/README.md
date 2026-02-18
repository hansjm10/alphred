# Dashboard API Contracts

This document defines the server API surface exposed by the dashboard integration layer.

Base path: `/api/dashboard`

## Error Shape

All route-level errors return this envelope:

```json
{
  "error": {
    "code": "invalid_request | not_found | auth_required | conflict | internal_error",
    "message": "human-readable message"
  }
}
```

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

### `POST /runs`

Launches a workflow run.

Request body (`DashboardRunLaunchRequest`):

```json
{
  "treeKey": "demo-tree",
  "repositoryName": "demo-repo",
  "branch": "feature/my-branch",
  "executionMode": "async",
  "cleanupWorktree": false
}
```

Validation notes:
- `treeKey` is required and must be a string.
- `repositoryName`, when provided, must be a non-empty string after trimming.
- `branch`, when provided, must be a string.
- `executionMode`, when provided, must be `"async"` or `"sync"`.
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

## Source of Truth

Canonical payload types live in:
- `apps/dashboard/src/server/dashboard-contracts.ts`

Route handlers live in:
- `apps/dashboard/app/api/dashboard/**/route.ts`

Error mapping lives in:
- `apps/dashboard/src/server/dashboard-errors.ts`
