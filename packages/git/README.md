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
- `AuthStatus`: `{ authenticated, user?, scopes?, error? }`

All provider implementations also support `checkAuth()` for pre-flight CLI
auth validation.

## Behavior Notes

- `cloneRepo(...)` is a placeholder in both providers and currently throws:
  `cloneRepo is not implemented yet. Tracked in the repo-clone issue.`
- Credential env precedence for subprocess calls:
  - GitHub: `ALPHRED_GH_TOKEN` over `GH_TOKEN`
  - GitHub Enterprise: `ALPHRED_GH_ENTERPRISE_TOKEN` over `GH_ENTERPRISE_TOKEN`
  - Azure DevOps: `ALPHRED_AZURE_DEVOPS_PAT` over `AZURE_DEVOPS_EXT_PAT`
- `GitHubScmProvider.createPullRequest(...)` extracts a numeric PR id from URLs
  matching `/pull/<number>`. If parsing fails, it falls back to using the full
  URL as `PullRequestResult.id`.
- `AzureDevOpsScmProvider.getWorkItem(...)` currently maps `labels` to `[]`
  because the current Azure adapter payload does not provide labels.
- `checkAuth()` behavior:
  - GitHub runs `gh auth status --hostname <host>` where `<host>` is derived
    from repo config (`[HOST/]OWNER/REPO`, default `github.com`)
  - Azure runs `az account show` and
    `az devops project list --organization https://dev.azure.com/<org>`
  - On failure, auth status is returned with remediation text (login command or
    env var guidance); no secrets are persisted by Alphred.
  - Consumers are expected to invoke `checkAuth()` in their own pre-flight
    command flows.

## Backward Compatibility

Provider-specific exports are still available:

- `getGitHubIssue`, `createGitHubPR`
- `getAzureWorkItem`, `createAzurePR`
