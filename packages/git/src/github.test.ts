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

import { checkAuth, checkAuthForRepo, createPullRequest, getIssue } from './github.js';

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

  it('uses GH_TOKEN when ALPHRED_GH_TOKEN is not provided', async () => {
    execFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 7,
        title: 'Title',
        body: 'Body',
        labels: [],
      }),
    });

    await expect(
      getIssue('owner/repo', 7, {
        GH_TOKEN: 'host-token',
      }),
    ).resolves.toEqual({
      number: 7,
      title: 'Title',
      body: 'Body',
      labels: [],
    });

    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'gh',
      [
        'issue',
        'view',
        '7',
        '--repo',
        'owner/repo',
        '--json',
        'number,title,body,labels',
      ],
      {
        env: {
          GH_TOKEN: 'host-token',
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

  it('uses GH_ENTERPRISE_TOKEN when ALPHRED_GH_ENTERPRISE_TOKEN is not provided', async () => {
    execFileAsyncMock.mockResolvedValueOnce({
      stdout: 'https://github.example.com/owner/repo/pull/1\n',
    });

    await expect(
      createPullRequest(
        'github.example.com/owner/repo',
        'Add feature',
        'Body text',
        'feat/branch',
        'develop',
        {
          GH_ENTERPRISE_TOKEN: 'host-enterprise-token',
        },
      ),
    ).resolves.toBe('https://github.example.com/owner/repo/pull/1');

    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'gh',
      [
        'pr',
        'create',
        '--repo',
        'github.example.com/owner/repo',
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
          GH_ENTERPRISE_TOKEN: 'host-enterprise-token',
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

  it('parses scopes with repeated quote characters', async () => {
    execFileAsyncMock.mockResolvedValueOnce({
      stdout: `
github.com
  ✓ Logged in to github.com account hansjm10 (keyring)
  - Token scopes: ""repo"", '''read:org''', ""
`,
      stderr: '',
    });

    await expect(checkAuth()).resolves.toEqual({
      authenticated: true,
      user: 'hansjm10',
      scopes: ['repo', 'read:org'],
    });
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

  it('uses repo hostname for auth checks', async () => {
    execFileAsyncMock.mockResolvedValueOnce({
      stdout: `
github.example.com
  ✓ Logged in to github.example.com account jane (keyring)
  - Token scopes: 'repo'
`,
      stderr: '',
    });

    await expect(
      checkAuthForRepo('github.example.com/owner/repo', {
        GH_ENTERPRISE_TOKEN: 'host-enterprise-token',
      }),
    ).resolves.toEqual({
      authenticated: true,
      user: 'jane',
      scopes: ['repo'],
    });

    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'gh',
      ['auth', 'status', '--hostname', 'github.example.com'],
      {
        env: {
          GH_ENTERPRISE_TOKEN: 'host-enterprise-token',
        },
      },
    );
  });

  it('returns hostname-specific remediation guidance for enterprise repos', async () => {
    execFileAsyncMock.mockRejectedValueOnce({
      stdout: '',
      stderr: 'not logged in to github.example.com',
    });

    const status = await checkAuthForRepo('github.example.com/owner/repo');

    expect(status.authenticated).toBe(false);
    expect(status.error).toContain('Run: gh auth login --hostname github.example.com');
    expect(status.error).toContain('not logged in to github.example.com');
  });

  it('returns a format error for malformed repo inputs', async () => {
    const status = await checkAuthForRepo('https://github.com/owner/repo');

    expect(status.authenticated).toBe(false);
    expect(status.error).toContain('Invalid GitHub repo format');
    expect(status.error).toContain('OWNER/REPO');
    expect(execFileAsyncMock).not.toHaveBeenCalled();
  });
});
