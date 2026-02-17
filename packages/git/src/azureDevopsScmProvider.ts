import type { AuthStatus, CreatePrParams, PullRequestResult, WorkItem } from '@alphred/shared';
import {
  checkAuth as checkAzureDevOpsAuth,
  cloneRepo as cloneAzureDevOpsRepo,
  createPullRequest as createAzurePullRequest,
  getWorkItem as getAzureWorkItem,
} from './azureDevops.js';
import type { AzureDevOpsScmProviderConfig, ScmProvider } from './scmProvider.js';
import { parsePositiveIntegerId } from './scmProviderUtils.js';

export class AzureDevOpsScmProvider implements ScmProvider {
  readonly kind = 'azure-devops';

  constructor(private readonly config: AzureDevOpsScmProviderConfig) {}

  getConfig(): AzureDevOpsScmProviderConfig {
    return this.config;
  }

  async checkAuth(): Promise<AuthStatus> {
    return checkAzureDevOpsAuth(this.config.organization);
  }

  async cloneRepo(remote: string, localPath: string, environment: NodeJS.ProcessEnv = process.env): Promise<void> {
    await cloneAzureDevOpsRepo(remote, localPath, environment);
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
      ...(params.targetBranch === undefined ? {} : { targetBranch: params.targetBranch }),
    });

    return {
      id: String(pullRequestId),
      provider: this.kind,
    };
  }
}
