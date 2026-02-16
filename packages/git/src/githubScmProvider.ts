import type { CreatePrParams, PullRequestResult, WorkItem } from '@alphred/shared';
import { createPullRequest as createGitHubPullRequest, getIssue } from './github.js';
import type { GitHubScmProviderConfig, ScmProvider } from './scmProvider.js';

const CLONE_STUB_MESSAGE = 'cloneRepo is not implemented yet. Tracked in the repo-clone issue.';

export class GitHubScmProvider implements ScmProvider {
  readonly kind = 'github';

  constructor(private readonly config: GitHubScmProviderConfig) {}

  async cloneRepo(_remote: string, _localPath: string): Promise<void> {
    throw new Error(CLONE_STUB_MESSAGE);
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

function parsePositiveIntegerId(id: number | string, entityName: string): number {
  const parsed = typeof id === 'number' ? id : Number(id);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${entityName} id: ${id}`);
  }

  return parsed;
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
