import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createPullRequestMock, getIssueMock } = vi.hoisted(() => ({
  createPullRequestMock: vi.fn(),
  getIssueMock: vi.fn(),
}));

vi.mock('./github.js', () => ({
  createPullRequest: createPullRequestMock,
  getIssue: getIssueMock,
}));

import { GitHubScmProvider } from './githubScmProvider.js';

describe('GitHubScmProvider', () => {
  const provider = new GitHubScmProvider({ kind: 'github', repo: 'owner/repo' });

  beforeEach(() => {
    createPullRequestMock.mockReset();
    getIssueMock.mockReset();
  });

  it('normalizes github issue responses into work items', async () => {
    getIssueMock.mockResolvedValueOnce({
      number: 42,
      title: 'Broken test',
      body: 'Fix flaky timing',
      labels: ['bug', 'urgent'],
    });

    await expect(provider.getWorkItem(42)).resolves.toEqual({
      id: '42',
      title: 'Broken test',
      body: 'Fix flaky timing',
      labels: ['bug', 'urgent'],
      provider: 'github',
    });

    expect(getIssueMock).toHaveBeenCalledWith('owner/repo', 42);
  });

  it('normalizes github pull request creation responses', async () => {
    createPullRequestMock.mockResolvedValueOnce('https://github.com/owner/repo/pull/123');

    await expect(
      provider.createPullRequest({
        title: 'Add feature',
        body: 'Body text',
        sourceBranch: 'feat/branch',
        targetBranch: 'main',
      }),
    ).resolves.toEqual({
      id: '123',
      url: 'https://github.com/owner/repo/pull/123',
      provider: 'github',
    });

    expect(createPullRequestMock).toHaveBeenCalledWith(
      'owner/repo',
      'Add feature',
      'Body text',
      'feat/branch',
      'main',
    );
  });

  it('passes undefined base branch when targetBranch is omitted', async () => {
    createPullRequestMock.mockResolvedValueOnce('https://github.com/owner/repo/pull/456');

    await expect(
      provider.createPullRequest({
        title: 'Add feature',
        body: 'Body text',
        sourceBranch: 'feat/branch',
      }),
    ).resolves.toEqual({
      id: '456',
      url: 'https://github.com/owner/repo/pull/456',
      provider: 'github',
    });

    expect(createPullRequestMock).toHaveBeenCalledWith(
      'owner/repo',
      'Add feature',
      'Body text',
      'feat/branch',
      undefined,
    );
  });

  it('rejects invalid issue ids', async () => {
    await expect(provider.getWorkItem('abc')).rejects.toThrow('Invalid GitHub issue id');
  });

  it.each([0, -1, 1.5])('rejects non-positive or non-integer numeric issue id: %s', async (invalidId) => {
    await expect(provider.getWorkItem(invalidId)).rejects.toThrow('Invalid GitHub issue id');
  });

  it('uses returned url as fallback id when pull request id cannot be parsed', async () => {
    createPullRequestMock.mockResolvedValueOnce('https://github.com/owner/repo/pulls');

    await expect(
      provider.createPullRequest({
        title: 'Add feature',
        body: 'Body text',
        sourceBranch: 'feat/branch',
      }),
    ).resolves.toEqual({
      id: 'https://github.com/owner/repo/pulls',
      url: 'https://github.com/owner/repo/pulls',
      provider: 'github',
    });
  });

  it('exposes cloneRepo as a stub until clone support lands', async () => {
    await expect(provider.cloneRepo('git@github.com:owner/repo.git', '/tmp/repo')).rejects.toThrow(
      'cloneRepo is not implemented yet',
    );
  });
});
