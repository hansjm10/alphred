import { AzureDevOpsScmProvider } from './azureDevopsScmProvider.js';
import { GitHubScmProvider } from './githubScmProvider.js';
import type { AuthStatus, CreatePrParams, PullRequestResult, ScmProviderKind, WorkItem } from '@alphred/shared';

export type ScmProvider = {
  readonly kind: ScmProviderKind;
  getConfig?(): ScmProviderConfig;
  checkAuth(environment?: NodeJS.ProcessEnv): Promise<AuthStatus>;
  cloneRepo(remote: string, localPath: string, environment?: NodeJS.ProcessEnv): Promise<void>;
  getWorkItem(id: number | string): Promise<WorkItem>;
  createPullRequest(params: CreatePrParams): Promise<PullRequestResult>;
};

export type GitHubScmProviderConfig = {
  kind: 'github';
  repo: string;
};

export type AzureDevOpsScmProviderConfig = {
  kind: 'azure-devops';
  organization: string;
  project: string;
  repository: string;
};

export type ScmProviderConfig = GitHubScmProviderConfig | AzureDevOpsScmProviderConfig;

export function createScmProvider(config: ScmProviderConfig): ScmProvider {
  switch (config.kind) {
    case 'github':
      return new GitHubScmProvider(config);
    case 'azure-devops':
      return new AzureDevOpsScmProvider(config);
    default: {
      const unsupportedKind = (config as { kind: string }).kind;
      throw new Error(`Unsupported SCM provider kind: ${unsupportedKind}`);
    }
  }
}
