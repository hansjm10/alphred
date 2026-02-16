import type { AuthStatus, CreatePrParams, PullRequestResult, WorkItem } from '@alphred/shared';
import {
  checkAuth as checkAzureDevOpsAuth,
  createPullRequest as createAzurePullRequest,
  getWorkItem as getAzureWorkItem,
} from './azureDevops.js';
import type { AzureDevOpsScmProviderConfig, ScmProvider } from './scmProvider.js';

const CLONE_STUB_MESSAGE = 'cloneRepo is not implemented yet. Tracked in the repo-clone issue.';

export class AzureDevOpsScmProvider implements ScmProvider {
  readonly kind = 'azure-devops';

  constructor(private readonly config: AzureDevOpsScmProviderConfig) {}

  async checkAuth(): Promise<AuthStatus> {
    return checkAzureDevOpsAuth(this.config.organization);
  }

  async cloneRepo(_remote: string, _localPath: string): Promise<void> {
    throw new Error(CLONE_STUB_MESSAGE);
  }

  async getWorkItem(id: number | string): Promise<WorkItem> {
    const workItemId = parsePositiveIntegerId(id, 'Azure DevOps work item');
    const workItem = await getAzureWorkItem(this.config.organization, this.config.project, workItemId);

    return {
      id: String(workItem.id),
      title: workItem.title,
      body: workItem.description,
      labels: [],
      provider: this.kind,
    };
  }

  async createPullRequest(params: CreatePrParams): Promise<PullRequestResult> {
    const pullRequestId = await createAzurePullRequest({
      organization: this.config.organization,
      project: this.config.project,
      repository: this.config.repository,
      title: params.title,
      description: params.body,
      sourceBranch: params.sourceBranch,
      ...(params.targetBranch !== undefined ? { targetBranch: params.targetBranch } : {}),
    });

    return {
      id: String(pullRequestId),
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
