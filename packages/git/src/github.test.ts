import { beforeEach, describe, expect, it, vi } from 'vitest';

const { accessMock, execFileAsyncMock, execFileMock, rmMock } = vi.hoisted(() => ({
  accessMock: vi.fn(),
  execFileAsyncMock: vi.fn(),
  execFileMock: vi.fn(),
  rmMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

vi.mock('node:util', () => ({
  promisify: () => execFileAsyncMock,
}));

vi.mock('node:fs/promises', () => ({
  access: accessMock,
  rm: rmMock,
}));

import { checkAuth, checkAuthForRepo, cloneRepo, createPullRequest, getIssue } from './github.js';

describe('github adapter', () => {
  beforeEach(() => {
    accessMock.mockReset();
    execFileMock.mockReset();
    execFileAsyncMock.mockReset();
    rmMock.mockReset();
    accessMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
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

  it('clones with gh by default', async () => {
    execFileAsyncMock.mockResolvedValueOnce({
      stdout: '',
    }).mockResolvedValueOnce({
      stdout: '',
    });

    await expect(
      cloneRepo('owner/repo', 'https://github.com/owner/repo.git', '/tmp/owner-repo', {
        GH_TOKEN: 'host-token',
      }),
    ).resolves.toBeUndefined();

    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      'gh',
      ['repo', 'clone', 'owner/repo', '/tmp/owner-repo'],
      {
        env: {
          GH_TOKEN: 'host-token',
        },
      },
    );
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      'git',
      ['-C', '/tmp/owner-repo', 'remote', 'set-url', 'origin', 'https://github.com/owner/repo.git'],
      {
        env: {
          GH_TOKEN: 'host-token',
        },
      },
    );
  });

  it('does not override origin when configured remote is blank', async () => {
    execFileAsyncMock.mockResolvedValueOnce({
      stdout: '',
    });

    await expect(
      cloneRepo('owner/repo', '   ', '/tmp/owner-repo', {
        GH_TOKEN: 'host-token',
      }),
    ).resolves.toBeUndefined();

    expect(execFileAsyncMock).toHaveBeenCalledTimes(1);
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'gh',
      ['repo', 'clone', 'owner/repo', '/tmp/owner-repo'],
      {
        env: {
          GH_TOKEN: 'host-token',
        },
      },
    );
  });

  it('throws when origin override fails after successful gh clone', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({
        stdout: '',
      })
      .mockRejectedValueOnce(new Error('set-url failed'));

    await expect(
      cloneRepo('owner/repo', 'https://github.com/owner/repo.git', '/tmp/owner-repo', {
        GH_TOKEN: 'host-token',
      }),
    ).rejects.toThrow('set-url failed');

    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      'gh',
      ['repo', 'clone', 'owner/repo', '/tmp/owner-repo'],
      {
        env: {
          GH_TOKEN: 'host-token',
        },
      },
    );
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      'git',
      ['-C', '/tmp/owner-repo', 'remote', 'set-url', 'origin', 'https://github.com/owner/repo.git'],
      {
        env: {
          GH_TOKEN: 'host-token',
        },
      },
    );
  });

  it('falls back to git clone when gh clone fails', async () => {
    execFileAsyncMock
      .mockRejectedValueOnce(new Error('gh clone failed'))
      .mockResolvedValueOnce({
        stdout: '',
      });

    await expect(
      cloneRepo('owner/repo', 'https://github.com/owner/repo.git', '/tmp/owner-repo', {
        GH_TOKEN: 'host-token',
      }),
    ).resolves.toBeUndefined();

    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      'gh',
      ['repo', 'clone', 'owner/repo', '/tmp/owner-repo'],
      {
        env: {
          GH_TOKEN: 'host-token',
        },
      },
    );
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      'git',
      [
        '-c',
        'http.https://github.com/.extraheader=AUTHORIZATION: Basic eC1hY2Nlc3MtdG9rZW46aG9zdC10b2tlbg==',
        'clone',
        'https://github.com/owner/repo.git',
        '/tmp/owner-repo',
      ],
      {
        env: {
          GH_TOKEN: 'host-token',
        },
      },
    );
    expect(rmMock).not.toHaveBeenCalled();
  });

  it('uses an HTTPS repo clone source when fallback runs with blank remote', async () => {
    execFileAsyncMock
      .mockRejectedValueOnce(new Error('gh clone failed'))
      .mockResolvedValueOnce({
        stdout: '',
      });

    await expect(
      cloneRepo('owner/repo', '   ', '/tmp/owner-repo', {
        GH_TOKEN: 'host-token',
      }),
    ).resolves.toBeUndefined();

    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      'git',
      [
        '-c',
        'http.https://github.com/.extraheader=AUTHORIZATION: Basic eC1hY2Nlc3MtdG9rZW46aG9zdC10b2tlbg==',
        'clone',
        'https://github.com/owner/repo.git',
        '/tmp/owner-repo',
      ],
      {
        env: {
          GH_TOKEN: 'host-token',
        },
      },
    );
  });

  it('cleans partial directories before fallback clone when gh clone fails', async () => {
    execFileAsyncMock
      .mockRejectedValueOnce(new Error('gh clone failed'))
      .mockRejectedValueOnce(Object.assign(new Error('destination exists'), {
        stderr: "fatal: destination path '/tmp/owner-repo' already exists and is not an empty directory.",
      }))
      .mockResolvedValueOnce({
        stdout: '',
      });
    accessMock
      .mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      .mockResolvedValueOnce(undefined);
    rmMock.mockResolvedValueOnce(undefined);

    await expect(
      cloneRepo('owner/repo', 'https://github.com/owner/repo.git', '/tmp/owner-repo', {}),
    ).resolves.toBeUndefined();

    expect(rmMock).toHaveBeenCalledWith('/tmp/owner-repo', { recursive: true, force: true });
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      'git',
      ['clone', 'https://github.com/owner/repo.git', '/tmp/owner-repo'],
      {
        env: {},
      },
    );
  });

  it('does not delete an existing clone target when fallback git clone fails', async () => {
    accessMock.mockResolvedValueOnce(undefined);
    execFileAsyncMock
      .mockRejectedValueOnce(new Error('gh clone failed'))
      .mockRejectedValueOnce(Object.assign(new Error('destination exists'), {
        stderr: "fatal: destination path '/tmp/owner-repo' already exists and is not an empty directory.",
      }));

    await expect(
      cloneRepo('owner/repo', 'https://github.com/owner/repo.git', '/tmp/owner-repo', {}),
    ).rejects.toThrow('destination exists');

    expect(rmMock).not.toHaveBeenCalled();
  });

  it('uses enterprise token when falling back to git clone for enterprise remotes', async () => {
    execFileAsyncMock
      .mockRejectedValueOnce(new Error('gh clone failed'))
      .mockResolvedValueOnce({
        stdout: '',
      });

    await expect(
      cloneRepo(
        'github.example.com/owner/repo',
        'https://github.example.com/owner/repo.git',
        '/tmp/owner-repo',
        {
          ALPHRED_GH_ENTERPRISE_TOKEN: 'ghes-token',
        },
      ),
    ).resolves.toBeUndefined();

    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      'gh',
      ['repo', 'clone', 'github.example.com/owner/repo', '/tmp/owner-repo'],
      {
        env: {
          ALPHRED_GH_ENTERPRISE_TOKEN: 'ghes-token',
          GH_ENTERPRISE_TOKEN: 'ghes-token',
        },
      },
    );
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      'git',
      [
        '-c',
        'http.https://github.example.com/.extraheader=AUTHORIZATION: Basic eC1hY2Nlc3MtdG9rZW46Z2hlcy10b2tlbg==',
        'clone',
        'https://github.example.com/owner/repo.git',
        '/tmp/owner-repo',
      ],
      {
        env: {
          ALPHRED_GH_ENTERPRISE_TOKEN: 'ghes-token',
          GH_ENTERPRISE_TOKEN: 'ghes-token',
        },
      },
    );
  });

  it('does not use enterprise token when git clone fallback targets github.com', async () => {
    execFileAsyncMock
      .mockRejectedValueOnce(new Error('gh clone failed'))
      .mockResolvedValueOnce({
        stdout: '',
      });

    await expect(
      cloneRepo(
        'owner/repo',
        'https://github.com/owner/repo.git',
        '/tmp/owner-repo',
        {
          ALPHRED_GH_ENTERPRISE_TOKEN: 'ghes-token',
        },
      ),
    ).resolves.toBeUndefined();

    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      'git',
      ['clone', 'https://github.com/owner/repo.git', '/tmp/owner-repo'],
      {
        env: {
          ALPHRED_GH_ENTERPRISE_TOKEN: 'ghes-token',
          GH_ENTERPRISE_TOKEN: 'ghes-token',
        },
      },
    );
  });

  it('does not fall back to GH_TOKEN when git clone fallback targets non-github hosts', async () => {
    execFileAsyncMock
      .mockRejectedValueOnce(new Error('gh clone failed'))
      .mockResolvedValueOnce({
        stdout: '',
      });

    await expect(
      cloneRepo(
        'github.example.com/owner/repo',
        'https://github.example.com/owner/repo.git',
        '/tmp/owner-repo',
        {
          GH_TOKEN: 'host-token',
        },
      ),
    ).resolves.toBeUndefined();

    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      'git',
      ['clone', 'https://github.example.com/owner/repo.git', '/tmp/owner-repo'],
      {
        env: {
          GH_TOKEN: 'host-token',
        },
      },
    );
  });

  it('uses plain git clone fallback when no token is available', async () => {
    execFileAsyncMock
      .mockRejectedValueOnce(new Error('gh clone failed'))
      .mockResolvedValueOnce({
        stdout: '',
      });

    await expect(
      cloneRepo('owner/repo', 'https://github.com/owner/repo.git', '/tmp/owner-repo', {}),
    ).resolves.toBeUndefined();

    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      'git',
      ['clone', 'https://github.com/owner/repo.git', '/tmp/owner-repo'],
      {
        env: {},
      },
    );
  });

  it('redacts auth headers when fallback git clone fails', async () => {
    execFileAsyncMock
      .mockRejectedValueOnce(new Error('gh clone failed'))
      .mockRejectedValueOnce(
        new Error(
          'Command failed: git -c http.https://github.com/.extraheader=AUTHORIZATION: Basic eC1hY2Nlc3MtdG9rZW46aG9zdC10b2tlbg== clone https://github.com/owner/repo.git /tmp/owner-repo',
        ),
      );

    const clonePromise = cloneRepo('owner/repo', 'https://github.com/owner/repo.git', '/tmp/owner-repo', {
      GH_TOKEN: 'host-token',
    });

    await expect(clonePromise).rejects.toThrow('AUTHORIZATION: <redacted>');
    await expect(clonePromise).rejects.not.toThrow('eC1hY2Nlc3MtdG9rZW46aG9zdC10b2tlbg==');
  });

  it('does not inject HTTP auth config for SSH remotes in git fallback clone', async () => {
    execFileAsyncMock
      .mockRejectedValueOnce(new Error('gh clone failed'))
      .mockResolvedValueOnce({
        stdout: '',
      });

    await expect(
      cloneRepo('owner/repo', 'git@github.com:owner/repo.git', '/tmp/owner-repo', {
        GH_TOKEN: 'host-token',
      }),
    ).resolves.toBeUndefined();

    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      'git',
      ['clone', 'git@github.com:owner/repo.git', '/tmp/owner-repo'],
      {
        env: {
          GH_TOKEN: 'host-token',
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
