import { beforeEach, describe, expect, it, vi } from 'vitest';

const { checkAuthMock, cloneRepoMock, createPullRequestMock, getWorkItemMock } = vi.hoisted(() => ({
  checkAuthMock: vi.fn(),
  cloneRepoMock: vi.fn(),
  createPullRequestMock: vi.fn(),
  getWorkItemMock: vi.fn(),
}));

vi.mock('./azureDevops.js', () => ({
  checkAuth: checkAuthMock,
  cloneRepo: cloneRepoMock,
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

  it('exposes provider config for identity validation', () => {
    expect(provider.getConfig()).toEqual({
      kind: 'azure-devops',
      organization: 'org',
      project: 'proj',
      repository: 'repo',
    });
  });

  beforeEach(() => {
    checkAuthMock.mockReset();
    cloneRepoMock.mockReset();
    createPullRequestMock.mockReset();
    getWorkItemMock.mockReset();
  });

  it('delegates auth checks to the azure devops adapter', async () => {
    checkAuthMock.mockResolvedValueOnce({
      authenticated: true,
      user: 'jordan@example.com',
    });

    await expect(provider.checkAuth()).resolves.toEqual({
      authenticated: true,
      user: 'jordan@example.com',
    });

    expect(checkAuthMock).toHaveBeenCalledWith('org');
  });

  it('passes an explicit environment to azure devops auth checks', async () => {
    checkAuthMock.mockResolvedValueOnce({
      authenticated: true,
      user: 'jordan@example.com',
    });
    const environment: NodeJS.ProcessEnv = {
      ALPHRED_AZURE_DEVOPS_PAT: 'token-from-io',
    };

    await expect(provider.checkAuth(environment)).resolves.toEqual({
      authenticated: true,
      user: 'jordan@example.com',
    });

    expect(checkAuthMock).toHaveBeenCalledWith('org', environment);
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
      {
        organization: 'org',
        project: 'proj',
        repository: 'repo',
        title: 'PR title',
        description: 'PR description',
        sourceBranch: 'feat/source',
        targetBranch: 'develop',
      },
    );
  });

  it('passes undefined target branch when targetBranch is omitted', async () => {
    createPullRequestMock.mockResolvedValueOnce(88);

    await expect(
      provider.createPullRequest({
        title: 'PR title',
        body: 'PR description',
        sourceBranch: 'feat/source',
      }),
    ).resolves.toEqual({
      id: '88',
      provider: 'azure-devops',
    });

    expect(createPullRequestMock).toHaveBeenCalledWith(
      {
        organization: 'org',
        project: 'proj',
        repository: 'repo',
        title: 'PR title',
        description: 'PR description',
        sourceBranch: 'feat/source',
      },
    );
  });

  it('rejects invalid work item ids', async () => {
    await expect(provider.getWorkItem('abc')).rejects.toThrow('Invalid Azure DevOps work item id');
  });

  it.each([0, -1, 1.5])('rejects non-positive or non-integer numeric work item id: %s', async (invalidId) => {
    await expect(provider.getWorkItem(invalidId)).rejects.toThrow('Invalid Azure DevOps work item id');
  });

  it('delegates clone calls to the azure devops adapter', async () => {
    cloneRepoMock.mockResolvedValueOnce(undefined);

    await expect(provider.cloneRepo('https://dev.azure.com/org/proj/_git/repo', '/tmp/repo')).resolves.toBeUndefined();

    expect(cloneRepoMock).toHaveBeenCalledWith(
      'https://dev.azure.com/org/proj/_git/repo',
      '/tmp/repo',
      expect.any(Object),
    );
  });
});
