import type { AuthStatus, CreatePrParams, PullRequestResult, WorkItem } from '@alphred/shared';
import {
  checkAuthForRepo as checkGitHubAuthForRepo,
  cloneRepo as cloneGitHubRepo,
  createPullRequest as createGitHubPullRequest,
  getIssue,
} from './github.js';
import { parsePositiveIntegerId } from './scmProviderUtils.js';
import type { GitHubScmProviderConfig, ScmProvider } from './scmProvider.js';

export class GitHubScmProvider implements ScmProvider {
  readonly kind = 'github';

  constructor(private readonly config: GitHubScmProviderConfig) {}

  getConfig(): GitHubScmProviderConfig {
    return this.config;
  }

  async checkAuth(): Promise<AuthStatus> {
    return checkGitHubAuthForRepo(this.config.repo);
  }

  async cloneRepo(remote: string, localPath: string, environment: NodeJS.ProcessEnv = process.env): Promise<void> {
    await cloneGitHubRepo(this.config.repo, remote, localPath, environment);
  }

  async getWorkItem(id: number | string): Promise<WorkItem> {
    const issueNumber = parsePositiveIntegerId(id, 'GitHub issue');
    const issue = await getIssue(this.config.repo, issueNumber);

    return {
      id: String(issue.number),
      title: issue.title,
      body: issue.body,
      labels: issue.labels,
      provider: this.kind,
    };
  }

  async createPullRequest(params: CreatePrParams): Promise<PullRequestResult> {
    const url = await createGitHubPullRequest(
      this.config.repo,
      params.title,
      params.body,
      params.sourceBranch,
      params.targetBranch,
    );

    return {
      id: extractGitHubPullRequestId(url),
      url,
      provider: this.kind,
    };
  }
}

function extractGitHubPullRequestId(url: string): string {
  const match = /\/pull\/(\d+)(?:[/?#]|$)/.exec(url);
  if (match?.[1]) {
    return match[1];
  }

  // Keep id populated for callers even when the URL is not in the expected
  // /pull/<number> form.
  return url;
}
