import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileAsyncMock, execFileMock, spawnMock } = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn(),
  execFileMock: vi.fn(),
  spawnMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  spawn: spawnMock,
}));

vi.mock('node:util', () => ({
  promisify: () => execFileAsyncMock,
}));

import { fetchRepository } from './repositoryClone.js';

const gitExecutablePattern = /(?:^|[/\\])git(?:\.exe)?$/;

function mockSuccessfulGitSpawn(): void {
  spawnMock.mockImplementationOnce(() => {
    const process = new EventEmitter() as ChildProcess;
    queueMicrotask(() => {
      process.emit('close', 0, null);
    });
    return process;
  });
}

function mockFailedGitSpawn(code = 1, signal: NodeJS.Signals | null = null): void {
  spawnMock.mockImplementationOnce(() => {
    const process = new EventEmitter() as ChildProcess;
    queueMicrotask(() => {
      process.emit('close', code, signal);
    });
    return process;
  });
}

describe('fetchRepository', () => {
  beforeEach(() => {
    execFileMock.mockReset();
    execFileAsyncMock.mockReset();
    spawnMock.mockReset();
  });

  it('applies Azure DevOps PAT auth header when fetching azure-devops repositories', async () => {
    mockSuccessfulGitSpawn();

    await expect(
      fetchRepository(
        '/tmp/repo',
        {
          ALPHRED_AZURE_DEVOPS_PAT: 'azure-pat',
        },
        {
          provider: 'azure-devops',
          remoteUrl: 'https://dev.azure.com/org/proj/_git/repo',
        },
      ),
    ).resolves.toBeUndefined();

    expect(spawnMock).toHaveBeenCalledWith(
      expect.stringMatching(gitExecutablePattern),
      [
        '-c',
        'http.https://dev.azure.com/.extraheader=AUTHORIZATION: Basic OmF6dXJlLXBhdA==',
        'fetch',
        '--all',
        '--prune',
        '--tags',
      ],
      {
        cwd: '/tmp/repo',
        stdio: 'inherit',
      },
    );
    expect(execFileAsyncMock).not.toHaveBeenCalled();
  });

  it('applies GitHub PAT auth header for github.com remotes', async () => {
    mockSuccessfulGitSpawn();

    await expect(
      fetchRepository(
        '/tmp/repo',
        {
          ALPHRED_GH_TOKEN: 'gh-token',
        },
        {
          provider: 'github',
          remoteUrl: 'https://github.com/acme/repo.git',
        },
      ),
    ).resolves.toBeUndefined();

    expect(spawnMock).toHaveBeenCalledWith(
      expect.stringMatching(gitExecutablePattern),
      [
        '-c',
        'http.https://github.com/.extraheader=AUTHORIZATION: Basic eC1hY2Nlc3MtdG9rZW46Z2gtdG9rZW4=',
        'fetch',
        '--all',
        '--prune',
        '--tags',
      ],
      {
        cwd: '/tmp/repo',
        stdio: 'inherit',
      },
    );
  });

  it('does not fall back to enterprise tokens for github.com remotes', async () => {
    mockSuccessfulGitSpawn();

    await expect(
      fetchRepository(
        '/tmp/repo',
        {
          ALPHRED_GH_ENTERPRISE_TOKEN: 'ghes-token',
        },
        {
          provider: 'github',
          remoteUrl: 'https://github.com/acme/repo.git',
        },
      ),
    ).resolves.toBeUndefined();

    expect(spawnMock).toHaveBeenCalledWith(
      expect.stringMatching(gitExecutablePattern),
      ['fetch', '--all', '--prune', '--tags'],
      {
        cwd: '/tmp/repo',
        stdio: 'inherit',
      },
    );
  });

  it('applies GitHub Enterprise token for non-github remotes', async () => {
    mockSuccessfulGitSpawn();

    await expect(
      fetchRepository(
        '/tmp/repo',
        {
          ALPHRED_GH_ENTERPRISE_TOKEN: 'ghes-token',
        },
        {
          provider: 'github',
          remoteUrl: 'https://github.example.com/acme/repo.git',
        },
      ),
    ).resolves.toBeUndefined();

    expect(spawnMock).toHaveBeenCalledWith(
      expect.stringMatching(gitExecutablePattern),
      [
        '-c',
        'http.https://github.example.com/.extraheader=AUTHORIZATION: Basic eC1hY2Nlc3MtdG9rZW46Z2hlcy10b2tlbg==',
        'fetch',
        '--all',
        '--prune',
        '--tags',
      ],
      {
        cwd: '/tmp/repo',
        stdio: 'inherit',
      },
    );
  });

  it('does not fall back to GH_TOKEN for non-github remotes', async () => {
    mockSuccessfulGitSpawn();

    await expect(
      fetchRepository(
        '/tmp/repo',
        {
          ALPHRED_GH_TOKEN: 'gh-token',
        },
        {
          provider: 'github',
          remoteUrl: 'https://github.example.com/acme/repo.git',
        },
      ),
    ).resolves.toBeUndefined();

    expect(spawnMock).toHaveBeenCalledWith(
      expect.stringMatching(gitExecutablePattern),
      ['fetch', '--all', '--prune', '--tags'],
      {
        cwd: '/tmp/repo',
        stdio: 'inherit',
      },
    );
  });

  it('does not add HTTP auth config for github SCP remotes', async () => {
    mockSuccessfulGitSpawn();

    await expect(
      fetchRepository(
        '/tmp/repo',
        {
          ALPHRED_GH_TOKEN: 'gh-token',
        },
        {
          provider: 'github',
          remoteUrl: 'git@github.com:acme/repo.git',
        },
      ),
    ).resolves.toBeUndefined();

    expect(spawnMock).toHaveBeenCalledWith(
      expect.stringMatching(gitExecutablePattern),
      ['fetch', '--all', '--prune', '--tags'],
      {
        cwd: '/tmp/repo',
        stdio: 'inherit',
      },
    );
  });

  it('does not add HTTP auth config for azure-devops SCP remotes', async () => {
    mockSuccessfulGitSpawn();

    await expect(
      fetchRepository(
        '/tmp/repo',
        {
          ALPHRED_AZURE_DEVOPS_PAT: 'azure-pat',
        },
        {
          provider: 'azure-devops',
          remoteUrl: 'git@ssh.dev.azure.com:v3/acme/platform/repo',
        },
      ),
    ).resolves.toBeUndefined();

    expect(spawnMock).toHaveBeenCalledWith(
      expect.stringMatching(gitExecutablePattern),
      ['fetch', '--all', '--prune', '--tags'],
      {
        cwd: '/tmp/repo',
        stdio: 'inherit',
      },
    );
  });

  it('uses plain fetch when no provider context or matching token is available', async () => {
    mockSuccessfulGitSpawn();

    await expect(fetchRepository('/tmp/repo', {})).resolves.toBeUndefined();

    expect(spawnMock).toHaveBeenCalledWith(
      expect.stringMatching(gitExecutablePattern),
      ['fetch', '--all', '--prune', '--tags'],
      {
        cwd: '/tmp/repo',
        stdio: 'inherit',
      },
    );
  });

  it('redacts auth headers in fetch failure messages', async () => {
    mockFailedGitSpawn();

    const fetchPromise = fetchRepository(
      '/tmp/repo',
      {
        ALPHRED_GH_TOKEN: 'gh-token',
      },
      {
        provider: 'github',
        remoteUrl: 'https://github.com/acme/repo.git',
      },
    );

    await expect(fetchPromise).rejects.toThrow('AUTHORIZATION: <redacted>');
    await expect(fetchPromise).rejects.not.toThrow('eC1hY2Nlc3MtdG9rZW46Z2gtdG9rZW4=');
  });
});
