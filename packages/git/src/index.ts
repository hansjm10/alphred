export { createWorktree, removeWorktree, listWorktrees, type WorktreeInfo, type CreateWorktreeParams } from './worktree.js';
export { WorktreeManager, type ManagedWorktree, type CreateRunWorktreeParams, type WorktreeManagerOptions } from './worktreeManager.js';
export {
  DEFAULT_BRANCH_TEMPLATE,
  generateBranchName,
  generateConfiguredBranchName,
  resolveBranchTemplate,
  type BranchNameContext,
} from './branchName.js';
export { getIssue as getGitHubIssue, createPullRequest as createGitHubPR, cloneRepo as cloneGitHubRepo, type GitHubIssue } from './github.js';
export {
  getWorkItem as getAzureWorkItem,
  createPullRequest as createAzurePR,
  cloneRepo as cloneAzureRepo,
  type AzureWorkItem,
  type CreateAzurePullRequestParams,
} from './azureDevops.js';
export { createScmProvider, type ScmProvider, type ScmProviderConfig, type GitHubScmProviderConfig, type AzureDevOpsScmProviderConfig } from './scmProvider.js';
export { GitHubScmProvider } from './githubScmProvider.js';
export { AzureDevOpsScmProvider } from './azureDevopsScmProvider.js';
export {
  ensureRepositoryClone,
  fetchRepository,
  repositorySyncModes,
  repositorySyncStatuses,
  repositorySyncStrategies,
  type EnsureRepositoryCloneParams,
  type EnsureRepositoryCloneResult,
  type RepositorySyncDetails,
  type RepositorySyncMode,
  type RepositorySyncStatus,
  type RepositorySyncStrategy,
} from './repositoryClone.js';
export { resolveSandboxDir, deriveSandboxRepoPath } from './sandbox.js';
