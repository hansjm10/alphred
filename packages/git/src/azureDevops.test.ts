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

import { checkAuth, createPullRequest, getWorkItem } from './azureDevops.js';

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

    await expect(
      getWorkItem('org', 'proj', 1001, {
        AZURE_DEVOPS_EXT_PAT: 'host-pat',
        ALPHRED_AZURE_DEVOPS_PAT: 'alphred-pat',
      }),
    ).resolves.toEqual({
      id: 1001,
      title: 'Investigate timeout',
      description: 'Investigate timeout in CI',
      type: 'Bug',
    });

    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'az',
      [
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
      ],
      {
        env: {
          AZURE_DEVOPS_EXT_PAT: 'alphred-pat',
          ALPHRED_AZURE_DEVOPS_PAT: 'alphred-pat',
        },
      },
    );
  });

  it('uses AZURE_DEVOPS_EXT_PAT when ALPHRED_AZURE_DEVOPS_PAT is not provided', async () => {
    execFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        id: 1002,
        fields: {
          'System.Title': 'Investigate auth',
          'System.Description': 'Investigate auth in CI',
          'System.WorkItemType': 'Task',
        },
      }),
    });

    await expect(
      getWorkItem('org', 'proj', 1002, {
        AZURE_DEVOPS_EXT_PAT: 'host-pat',
      }),
    ).resolves.toEqual({
      id: 1002,
      title: 'Investigate auth',
      description: 'Investigate auth in CI',
      type: 'Task',
    });

    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'az',
      [
        'boards',
        'work-item',
        'show',
        '--id',
        '1002',
        '--org',
        'https://dev.azure.com/org',
        '--project',
        'proj',
        '--output',
        'json',
      ],
      {
        env: {
          AZURE_DEVOPS_EXT_PAT: 'host-pat',
        },
      },
    );
  });

  it('creates a pull request and returns pullRequestId', async () => {
    execFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({ pullRequestId: 77 }),
    });

    await expect(
      createPullRequest(
        {
          organization: 'org',
          project: 'proj',
          repository: 'repo',
          title: 'PR title',
          description: 'PR description',
          sourceBranch: 'feat/source',
          targetBranch: 'main',
        },
        {
          AZURE_DEVOPS_EXT_PAT: 'host-pat',
        },
      ),
    ).resolves.toBe(77);

    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'az',
      [
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
      ],
      {
        env: {
          AZURE_DEVOPS_EXT_PAT: 'host-pat',
        },
      },
    );
  });

  it('returns authenticated status after account and devops checks pass', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          user: {
            name: 'jordan@example.com',
          },
        }),
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          value: [],
        }),
      });

    await expect(
      checkAuth('org', {
        ALPHRED_AZURE_DEVOPS_PAT: 'alphred-pat',
      }),
    ).resolves.toEqual({
      authenticated: true,
      user: 'jordan@example.com',
    });

    expect(execFileAsyncMock).toHaveBeenNthCalledWith(1, 'az', ['account', 'show', '--output', 'json'], {
      env: {
        ALPHRED_AZURE_DEVOPS_PAT: 'alphred-pat',
        AZURE_DEVOPS_EXT_PAT: 'alphred-pat',
      },
    });

    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      'az',
      ['devops', 'project', 'list', '--organization', 'https://dev.azure.com/org', '--output', 'json'],
      {
        env: {
          ALPHRED_AZURE_DEVOPS_PAT: 'alphred-pat',
          AZURE_DEVOPS_EXT_PAT: 'alphred-pat',
        },
      },
    );
  });

  it('uses AZURE_DEVOPS_EXT_PAT for auth checks when ALPHRED_AZURE_DEVOPS_PAT is not provided', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          user: {
            name: 'jordan@example.com',
          },
        }),
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          value: [],
        }),
      });

    await expect(
      checkAuth('org', {
        AZURE_DEVOPS_EXT_PAT: 'host-pat',
      }),
    ).resolves.toEqual({
      authenticated: true,
      user: 'jordan@example.com',
    });

    expect(execFileAsyncMock).toHaveBeenNthCalledWith(1, 'az', ['account', 'show', '--output', 'json'], {
      env: {
        AZURE_DEVOPS_EXT_PAT: 'host-pat',
      },
    });

    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      'az',
      ['devops', 'project', 'list', '--organization', 'https://dev.azure.com/org', '--output', 'json'],
      {
        env: {
          AZURE_DEVOPS_EXT_PAT: 'host-pat',
        },
      },
    );
  });

  it('returns remediation guidance when account auth is missing', async () => {
    execFileAsyncMock.mockRejectedValueOnce({
      stdout: '',
      stderr: 'az login required',
    });

    const status = await checkAuth('org');

    expect(status.authenticated).toBe(false);
    expect(status.error).toContain('Run: az login');
    expect(status.error).not.toContain('ALPHRED_AZURE_DEVOPS_PAT');
    expect(status.error).toContain('az login required');
  });

  it('returns account-login guidance even when a PAT is present but account auth fails', async () => {
    execFileAsyncMock.mockRejectedValueOnce({
      stdout: '',
      stderr: 'az login required',
    });

    const status = await checkAuth('org', {
      ALPHRED_AZURE_DEVOPS_PAT: 'alphred-pat',
    });

    expect(status.authenticated).toBe(false);
    expect(status.error).toContain('Run: az login');
    expect(status.error).not.toContain('ALPHRED_AZURE_DEVOPS_PAT');
    expect(execFileAsyncMock).toHaveBeenCalledTimes(1);
  });

  it('returns remediation guidance when devops auth is missing', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          user: {
            name: 'jordan@example.com',
          },
        }),
      })
      .mockRejectedValueOnce({
        stdout: '',
        stderr: 'organization auth required',
      });

    const status = await checkAuth('org');

    expect(status.authenticated).toBe(false);
    expect(status.error).toContain('az devops login --organization https://dev.azure.com/org');
    expect(status.error).toContain('ALPHRED_AZURE_DEVOPS_PAT');
    expect(status.error).toContain('organization auth required');
  });
});
