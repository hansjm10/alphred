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

- `cloneRepo(...)` is implemented in both providers:
  - GitHub: `gh repo clone <repo> <path>` with `git clone <remote> <path>` fallback.
  - Azure DevOps: `git clone <remote> <path>`.
  - Azure clone intentionally uses `git clone` in this adapter so token/env handling is shared with fetch/clone auth helpers instead of depending on `az repos clone`.
- Credential env precedence for subprocess calls:
  - GitHub: `ALPHRED_GH_TOKEN` over `GH_TOKEN`
  - GitHub Enterprise: `ALPHRED_GH_ENTERPRISE_TOKEN` over `GH_ENTERPRISE_TOKEN`
  - Azure DevOps: `ALPHRED_AZURE_DEVOPS_PAT` over `AZURE_DEVOPS_EXT_PAT`
- HTTP auth-header scoping:
  - `-c http.<origin>/.extraheader=...` is only added when the remote resolves to an HTTP(S) origin.
  - SSH/SCP remotes run clone/fetch without `http.extraheader` injection.
- Sandbox helpers:
  - `resolveSandboxDir()` uses `ALPHRED_SANDBOX_DIR` or defaults to `~/.alphred/repos`.
  - `deriveSandboxRepoPath(provider, remoteRef)` deterministically maps refs to sandbox paths.
- Registry clone orchestration:
  - `ensureRepositoryClone(...)` integrates with the repository registry (`@alphred/db`), clones or fetches existing clones, and keeps `clone_status` / `local_path` in sync.
- `GitHubScmProvider.createPullRequest(...)` extracts a numeric PR id from URLs
  matching `/pull/<number>`. If parsing fails, it falls back to using the full
  URL as `PullRequestResult.id`.
- `AzureDevOpsScmProvider.getWorkItem(...)` currently maps `labels` to `[]`
  because the current Azure adapter payload does not provide labels.
- `checkAuth()` behavior:
  - GitHub runs `gh auth status --hostname <host>` where `<host>` is derived
    from repo config (`OWNER/REPO` or `[HOST/]OWNER/REPO`, default
    `github.com` for `OWNER/REPO` only). URL-style repo values (for example
    `https://github.com/owner/repo`) are rejected as invalid config.
  - Azure runs `az account show` and
    `az devops project list --organization https://dev.azure.com/<org>`
    after account auth succeeds.
  - On failure, auth status is returned with remediation text (login command or
    env var guidance where applicable); no secrets are persisted by Alphred.
  - Consumers are expected to invoke `checkAuth()` in their own pre-flight
    command flows.

## Backward Compatibility

Provider-specific exports are still available:

- `getGitHubIssue`, `createGitHubPR`
- `getAzureWorkItem`, `createAzurePR`
