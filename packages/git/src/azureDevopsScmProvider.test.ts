import { beforeEach, describe, expect, it, vi } from 'vitest';

const { checkAuthMock, createPullRequestMock, getWorkItemMock } = vi.hoisted(() => ({
  checkAuthMock: vi.fn(),
  createPullRequestMock: vi.fn(),
  getWorkItemMock: vi.fn(),
}));

vi.mock('./azureDevops.js', () => ({
  checkAuth: checkAuthMock,
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
    checkAuthMock.mockReset();
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
      'org',
      'proj',
      'repo',
      'PR title',
      'PR description',
      'feat/source',
      undefined,
    );
  });

  it('rejects invalid work item ids', async () => {
    await expect(provider.getWorkItem('abc')).rejects.toThrow('Invalid Azure DevOps work item id');
  });

  it.each([0, -1, 1.5])('rejects non-positive or non-integer numeric work item id: %s', async (invalidId) => {
    await expect(provider.getWorkItem(invalidId)).rejects.toThrow('Invalid Azure DevOps work item id');
  });

  it('exposes cloneRepo as a stub until clone support lands', async () => {
    await expect(provider.cloneRepo('https://dev.azure.com/org/proj/_git/repo', '/tmp/repo')).rejects.toThrow(
      'cloneRepo is not implemented yet',
    );
  });
});
