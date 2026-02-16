import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createPullRequestMock, getWorkItemMock } = vi.hoisted(() => ({
  createPullRequestMock: vi.fn(),
  getWorkItemMock: vi.fn(),
}));

vi.mock('./azureDevops.js', () => ({
  createPullRequest: createPullRequestMock,
  getWorkItem: getWorkItemMock,
}));

import { AzureDevOpsScmProvider } from './azureDevopsScmProvider.js';

describe('AzureDevOpsScmProvider', () => {
  const provider = new AzureDevOpsScmProvider({
    kind: 'azure-devops',
    organization: 'org',
    project: 'proj',
    repository: 'repo',
  });

  beforeEach(() => {
    createPullRequestMock.mockReset();
    getWorkItemMock.mockReset();
  });

  it('normalizes azure devops work item responses', async () => {
    getWorkItemMock.mockResolvedValueOnce({
      id: 1001,
      title: 'Investigate timeout',
      description: 'Investigate timeout in CI',
      type: 'Bug',
    });

    await expect(provider.getWorkItem('1001')).resolves.toEqual({
      id: '1001',
      title: 'Investigate timeout',
      body: 'Investigate timeout in CI',
      labels: [],
      provider: 'azure-devops',
    });

    expect(getWorkItemMock).toHaveBeenCalledWith('org', 'proj', 1001);
  });

  it('normalizes azure devops pull request creation responses', async () => {
    createPullRequestMock.mockResolvedValueOnce(77);

    await expect(
      provider.createPullRequest({
        title: 'PR title',
        body: 'PR description',
        sourceBranch: 'feat/source',
        targetBranch: 'develop',
      }),
    ).resolves.toEqual({
      id: '77',
      provider: 'azure-devops',
    });

    expect(createPullRequestMock).toHaveBeenCalledWith(
      'org',
      'proj',
      'repo',
      'PR title',
      'PR description',
      'feat/source',
      'develop',
    );
  });

  it('rejects invalid work item ids', async () => {
    await expect(provider.getWorkItem('abc')).rejects.toThrow('Invalid Azure DevOps work item id');
  });

  it('exposes cloneRepo as a stub until clone support lands', async () => {
    await expect(provider.cloneRepo('https://dev.azure.com/org/proj/_git/repo', '/tmp/repo')).rejects.toThrow(
      'cloneRepo is not implemented yet',
    );
  });
});
