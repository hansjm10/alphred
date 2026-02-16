# @alphred/git

Provider adapters and helpers for SCM operations.

## Normalized Provider API

Use `createScmProvider(config)` when you want provider-agnostic behavior:

```ts
import { createScmProvider } from '@alphred/git';

const provider = createScmProvider({ kind: 'github', repo: 'owner/repo' });

const workItem = await provider.getWorkItem(42);
const pr = await provider.createPullRequest({
  title: 'feat: example',
  body: 'details',
  sourceBranch: 'feat/example',
});
```

Returned shapes are normalized via `@alphred/shared`:

- `WorkItem`: `{ id, title, body, labels, provider }`
- `PullRequestResult`: `{ id, url?, provider }`

## Behavior Notes

- `cloneRepo(...)` is a placeholder in both providers and currently throws:
  `cloneRepo is not implemented yet. Tracked in the repo-clone issue.`
- `GitHubScmProvider.createPullRequest(...)` extracts a numeric PR id from URLs
  matching `/pull/<number>`. If parsing fails, it falls back to using the full
  URL as `PullRequestResult.id`.
- `AzureDevOpsScmProvider.getWorkItem(...)` currently maps `labels` to `[]`
  because the current Azure adapter payload does not provide labels.

## Backward Compatibility

Provider-specific exports are still available:

- `getGitHubIssue`, `createGitHubPR`
- `getAzureWorkItem`, `createAzurePR`
