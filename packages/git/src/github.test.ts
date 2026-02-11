import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileAsyncMock, execFileMock } = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn(),
  execFileMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

vi.mock('node:util', () => ({
  promisify: () => execFileAsyncMock,
}));

import { createPullRequest, getIssue } from './github.js';

describe('github adapter', () => {
  beforeEach(() => {
    execFileMock.mockReset();
    execFileAsyncMock.mockReset();
  });

  it('fetches issue details and maps label names', async () => {
    execFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 42,
        title: 'Broken test',
        body: 'Fix flaky timing',
        labels: [{ name: 'bug' }, { name: 'urgent' }],
      }),
    });

    await expect(getIssue('owner/repo', 42)).resolves.toEqual({
      number: 42,
      title: 'Broken test',
      body: 'Fix flaky timing',
      labels: ['bug', 'urgent'],
    });

    expect(execFileAsyncMock).toHaveBeenCalledWith('gh', [
      'issue',
      'view',
      '42',
      '--repo',
      'owner/repo',
      '--json',
      'number,title,body,labels',
    ]);
  });

  it('creates a pull request and returns the URL', async () => {
    execFileAsyncMock.mockResolvedValueOnce({
      stdout: 'https://github.com/owner/repo/pull/123\n',
    });

    await expect(
      createPullRequest('owner/repo', 'Add feature', 'Body text', 'feat/branch', 'develop'),
    ).resolves.toBe('https://github.com/owner/repo/pull/123');

    expect(execFileAsyncMock).toHaveBeenCalledWith('gh', [
      'pr',
      'create',
      '--repo',
      'owner/repo',
      '--title',
      'Add feature',
      '--body',
      'Body text',
      '--head',
      'feat/branch',
      '--base',
      'develop',
    ]);
  });
});
