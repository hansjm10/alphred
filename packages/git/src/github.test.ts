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

import { checkAuth, createPullRequest, getIssue } from './github.js';

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

    await expect(
      getIssue('owner/repo', 42, {
        GH_TOKEN: 'host-token',
        ALPHRED_GH_TOKEN: 'alphred-token',
      }),
    ).resolves.toEqual({
      number: 42,
      title: 'Broken test',
      body: 'Fix flaky timing',
      labels: ['bug', 'urgent'],
    });

    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'gh',
      [
        'issue',
        'view',
        '42',
        '--repo',
        'owner/repo',
        '--json',
        'number,title,body,labels',
      ],
      {
        env: {
          GH_TOKEN: 'alphred-token',
          ALPHRED_GH_TOKEN: 'alphred-token',
        },
      },
    );
  });

  it('creates a pull request and returns the URL', async () => {
    execFileAsyncMock.mockResolvedValueOnce({
      stdout: 'https://github.com/owner/repo/pull/123\n',
    });

    await expect(
      createPullRequest(
        'owner/repo',
        'Add feature',
        'Body text',
        'feat/branch',
        'develop',
        {
          GH_ENTERPRISE_TOKEN: 'host-enterprise-token',
          ALPHRED_GH_ENTERPRISE_TOKEN: 'alphred-enterprise-token',
        },
      ),
    ).resolves.toBe('https://github.com/owner/repo/pull/123');

    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'gh',
      [
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
      ],
      {
        env: {
          GH_ENTERPRISE_TOKEN: 'alphred-enterprise-token',
          ALPHRED_GH_ENTERPRISE_TOKEN: 'alphred-enterprise-token',
        },
      },
    );
  });

  it('returns authenticated status with parsed user and scopes', async () => {
    execFileAsyncMock.mockResolvedValueOnce({
      stdout: `
github.com
  ✓ Logged in to github.com account hansjm10 (keyring)
  - Token scopes: 'repo', 'read:org'
`,
      stderr: '',
    });

    await expect(
      checkAuth({
        ALPHRED_GH_TOKEN: 'alphred-token',
      }),
    ).resolves.toEqual({
      authenticated: true,
      user: 'hansjm10',
      scopes: ['repo', 'read:org'],
    });

    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'gh',
      ['auth', 'status', '--hostname', 'github.com'],
      {
        env: {
          ALPHRED_GH_TOKEN: 'alphred-token',
          GH_TOKEN: 'alphred-token',
        },
      },
    );
  });

  it('returns remediation guidance when not authenticated', async () => {
    execFileAsyncMock.mockRejectedValueOnce({
      stdout: '',
      stderr: 'not logged in to github.com',
    });

    const status = await checkAuth();

    expect(status.authenticated).toBe(false);
    expect(status.error).toContain('Run: gh auth login --hostname github.com');
    expect(status.error).toContain('ALPHRED_GH_TOKEN');
    expect(status.error).toContain('not logged in to github.com');
  });
});
