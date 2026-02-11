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

import { createPullRequest, getWorkItem } from './azureDevops.js';

describe('azure devops adapter', () => {
  beforeEach(() => {
    execFileMock.mockReset();
    execFileAsyncMock.mockReset();
  });

  it('fetches work item details and maps fields', async () => {
    execFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        id: 1001,
        fields: {
          'System.Title': 'Investigate timeout',
          'System.Description': 'Investigate timeout in CI',
          'System.WorkItemType': 'Bug',
        },
      }),
    });

    await expect(getWorkItem('org', 'proj', 1001)).resolves.toEqual({
      id: 1001,
      title: 'Investigate timeout',
      description: 'Investigate timeout in CI',
      type: 'Bug',
    });

    expect(execFileAsyncMock).toHaveBeenCalledWith('az', [
      'boards',
      'work-item',
      'show',
      '--id',
      '1001',
      '--org',
      'https://dev.azure.com/org',
      '--project',
      'proj',
      '--output',
      'json',
    ]);
  });

  it('creates a pull request and returns pullRequestId', async () => {
    execFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({ pullRequestId: 77 }),
    });

    await expect(
      createPullRequest('org', 'proj', 'repo', 'PR title', 'PR description', 'feat/source', 'main'),
    ).resolves.toBe(77);

    expect(execFileAsyncMock).toHaveBeenCalledWith('az', [
      'repos',
      'pr',
      'create',
      '--org',
      'https://dev.azure.com/org',
      '--project',
      'proj',
      '--repository',
      'repo',
      '--title',
      'PR title',
      '--description',
      'PR description',
      '--source-branch',
      'feat/source',
      '--target-branch',
      'main',
      '--output',
      'json',
    ]);
  });
});
