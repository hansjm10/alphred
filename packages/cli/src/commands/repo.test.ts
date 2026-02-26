import { describe, expect, it, vi } from 'vitest';
import {
  createDatabase,
  getRepositoryByName,
  insertRepository,
  insertRunWorktree,
  materializeWorkflowRunFromTree,
  migrateDatabase,
} from '@alphred/db';
import type { ScmProviderConfig } from '@alphred/git';
import { main } from '../bin.js';
import {
  createCapturedIo,
  createDependencies,
  createUnusedProviderResolver,
  seedSingleNodeTree,
} from '../test-support.js';

describe('CLI repo commands', () => {
  it('adds github and azure repositories', async () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    const createScmProviderMock = vi.fn((config: ScmProviderConfig) => ({
      checkAuth: async () => ({
        authenticated: true,
        user: config.kind === 'github' ? 'octocat' : 'azure-user',
      }),
    }));
    const githubCaptured = createCapturedIo();

    const githubExitCode = await main(['repo', 'add', '--name', 'frontend', '--github', 'acme/frontend'], {
      dependencies: createDependencies(db, createUnusedProviderResolver(), {
        createScmProvider: createScmProviderMock,
      }),
      io: githubCaptured.io,
    });

    expect(githubExitCode).toBe(0);
    expect(githubCaptured.stderr).toEqual([]);
    expect(githubCaptured.stdout).toContain('Registered repository "frontend" (github:acme/frontend).');

    const azureCaptured = createCapturedIo();
    const azureExitCode = await main(['repo', 'add', '--name', 'backend', '--azure', 'myorg/myproject/backend'], {
      dependencies: createDependencies(db, createUnusedProviderResolver(), {
        createScmProvider: createScmProviderMock,
      }),
      io: azureCaptured.io,
    });

    expect(azureExitCode).toBe(0);
    expect(azureCaptured.stderr).toEqual([]);
    expect(azureCaptured.stdout).toContain(
      'Registered repository "backend" (azure-devops:myorg/myproject/backend).',
    );
    expect(createScmProviderMock).toHaveBeenCalledWith({
      kind: 'github',
      repo: 'acme/frontend',
    });
    expect(createScmProviderMock).toHaveBeenCalledWith({
      kind: 'azure-devops',
      organization: 'myorg',
      project: 'myproject',
      repository: 'backend',
    });
  });

  it('warns on repo add when scm auth is missing and still persists the repository', async () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    const createScmProviderMock = vi.fn((_config: ScmProviderConfig) => ({
      checkAuth: async () => ({
        authenticated: false,
        error: 'Run "gh auth login" to authenticate GitHub CLI.',
      }),
    }));
    const captured = createCapturedIo();

    const exitCode = await main(['repo', 'add', '--name', 'frontend', '--github', 'acme/frontend'], {
      dependencies: createDependencies(db, createUnusedProviderResolver(), {
        createScmProvider: createScmProviderMock,
      }),
      io: captured.io,
    });

    expect(exitCode).toBe(0);
    expect(captured.stderr).toEqual([
      'Warning: GitHub authentication is not configured. Continuing "repo add".',
      'Run "gh auth login" to authenticate GitHub CLI.',
    ]);
    expect(captured.stdout).toContain('Registered repository "frontend" (github:acme/frontend).');
    expect(getRepositoryByName(db, 'frontend')).not.toBeNull();
  });

  it('normalizes repository names when adding', async () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    const addCaptured = createCapturedIo();

    const addExitCode = await main(['repo', 'add', '--name', '  frontend  ', '--github', 'acme/frontend'], {
      dependencies: createDependencies(db, createUnusedProviderResolver()),
      io: addCaptured.io,
    });

    expect(addExitCode).toBe(0);
    expect(addCaptured.stderr).toEqual([]);
    expect(addCaptured.stdout).toContain('Registered repository "frontend" (github:acme/frontend).');
    expect(getRepositoryByName(db, 'frontend')).not.toBeNull();
    expect(getRepositoryByName(db, '  frontend  ')).toBeNull();

    const showCaptured = createCapturedIo();
    const showExitCode = await main(['repo', 'show', 'frontend'], {
      dependencies: createDependencies(db, createUnusedProviderResolver()),
      io: showCaptured.io,
    });

    expect(showExitCode).toBe(0);
    expect(showCaptured.stderr).toEqual([]);
    expect(showCaptured.stdout).toContain('Name: frontend');
  });

  it('lists and shows registered repositories', async () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    insertRepository(db, {
      name: 'frontend',
      provider: 'github',
      remoteUrl: 'https://github.com/acme/frontend.git',
      remoteRef: 'acme/frontend',
      defaultBranch: 'main',
      cloneStatus: 'cloned',
      localPath: '/tmp/alphred/repos/github/acme/frontend',
    });

    const listCaptured = createCapturedIo();
    const listExitCode = await main(['repo', 'list'], {
      dependencies: createDependencies(db, createUnusedProviderResolver()),
      io: listCaptured.io,
    });

    expect(listExitCode).toBe(0);
    expect(listCaptured.stderr).toEqual([]);
    expect(listCaptured.stdout.some(line => line.includes('NAME'))).toBe(true);
    expect(listCaptured.stdout.some(line => line.includes('frontend'))).toBe(true);

    const showCaptured = createCapturedIo();
    const showExitCode = await main(['repo', 'show', 'frontend'], {
      dependencies: createDependencies(db, createUnusedProviderResolver()),
      io: showCaptured.io,
    });

    expect(showExitCode).toBe(0);
    expect(showCaptured.stderr).toEqual([]);
    expect(showCaptured.stdout).toContain('Name: frontend');
    expect(showCaptured.stdout).toContain('Provider: github');
    expect(showCaptured.stdout).toContain('Remote ref: acme/frontend');
  });

  it('removes repositories and optionally purges local clones', async () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    insertRepository(db, {
      name: 'frontend',
      provider: 'github',
      remoteUrl: 'https://github.com/acme/frontend.git',
      remoteRef: 'acme/frontend',
      cloneStatus: 'cloned',
      localPath: '/tmp/alphred/repos/github/acme/frontend',
    });
    const removeDirectory = vi.fn(async () => undefined);
    const captured = createCapturedIo();

    const exitCode = await main(['repo', 'remove', 'frontend', '--purge'], {
      dependencies: createDependencies(db, createUnusedProviderResolver(), {
        removeDirectory,
      }),
      io: captured.io,
    });

    expect(exitCode).toBe(0);
    expect(removeDirectory).toHaveBeenCalledWith('/tmp/alphred/repos/github/acme/frontend');
    expect(getRepositoryByName(db, 'frontend')).toBeNull();
  });

  it('preserves repository registry state when purge fails', async () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    insertRepository(db, {
      name: 'frontend',
      provider: 'github',
      remoteUrl: 'https://github.com/acme/frontend.git',
      remoteRef: 'acme/frontend',
      cloneStatus: 'cloned',
      localPath: '/tmp/alphred/repos/github/acme/frontend',
    });
    const captured = createCapturedIo();

    const exitCode = await main(['repo', 'remove', 'frontend', '--purge'], {
      dependencies: createDependencies(db, createUnusedProviderResolver(), {
        removeDirectory: async () => {
          throw new Error('simulated purge failure');
        },
      }),
      io: captured.io,
    });

    expect(exitCode).toBe(4);
    expect(captured.stderr).toEqual(['Failed to remove repository: simulated purge failure']);
    expect(getRepositoryByName(db, 'frontend')).not.toBeNull();
  });

  it('returns runtime failure with a clear message when run-worktree history references a repository', async () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    seedSingleNodeTree(db, 'design_tree');
    const repository = insertRepository(db, {
      name: 'frontend',
      provider: 'github',
      remoteUrl: 'https://github.com/acme/frontend.git',
      remoteRef: 'acme/frontend',
      cloneStatus: 'cloned',
      localPath: '/tmp/alphred/repos/github/acme/frontend',
    });
    const run = materializeWorkflowRunFromTree(db, { treeKey: 'design_tree' });
    insertRunWorktree(db, {
      workflowRunId: run.run.id,
      repositoryId: repository.id,
      worktreePath: '/tmp/alphred/worktrees/design-tree-1',
      branch: 'alphred/design_tree/1',
      commitHash: 'abc123',
    });
    const captured = createCapturedIo();

    const exitCode = await main(['repo', 'remove', 'frontend'], {
      dependencies: createDependencies(db, createUnusedProviderResolver()),
      io: captured.io,
    });

    expect(exitCode).toBe(4);
    expect(captured.stderr).toEqual([
      'Repository "frontend" cannot be removed because run-worktree history references it.',
    ]);
    expect(getRepositoryByName(db, 'frontend')).not.toBeNull();
  });

  it('syncs repositories via ensureRepositoryClone', async () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    insertRepository(db, {
      name: 'frontend',
      provider: 'github',
      remoteUrl: 'https://github.com/acme/frontend.git',
      remoteRef: 'acme/frontend',
      cloneStatus: 'pending',
      localPath: null,
    });
    const ensureRepositoryCloneMock = vi.fn(async () => {
      const repository = getRepositoryByName(db, 'frontend');
      if (!repository) {
        throw new Error('Expected repository row.');
      }
      return {
        repository: {
          ...repository,
          cloneStatus: 'cloned' as const,
          localPath: '/tmp/alphred/repos/github/acme/frontend',
        },
        action: 'cloned' as const,
        sync: {
          mode: 'pull' as const,
          strategy: 'ff-only' as const,
          branch: 'main',
          status: 'updated' as const,
          conflictMessage: null,
        },
      };
    });
    const createScmProviderMock = vi.fn((_config: ScmProviderConfig) => ({
      checkAuth: async () => ({
        authenticated: true,
      }),
    }));
    const captured = createCapturedIo();

    const exitCode = await main(['repo', 'sync', 'frontend'], {
      dependencies: createDependencies(db, createUnusedProviderResolver(), {
        createScmProvider: createScmProviderMock,
        ensureRepositoryClone: ensureRepositoryCloneMock,
      }),
      io: captured.io,
    });

    expect(exitCode).toBe(0);
    expect(createScmProviderMock).toHaveBeenCalledWith({
      kind: 'github',
      repo: 'acme/frontend',
    });
    expect(ensureRepositoryCloneMock).toHaveBeenCalledTimes(1);
    expect(ensureRepositoryCloneMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sync: {
          mode: 'pull',
          strategy: 'ff-only',
        },
      }),
    );
    expect(captured.stdout.some(line => line.includes('Repository "frontend" cloned'))).toBe(true);
    expect(captured.stdout).toContain('Sync status: updated (mode=pull, strategy=ff-only, branch=main).');
  });

  it('accepts an explicit sync strategy for repo sync', async () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    insertRepository(db, {
      name: 'frontend',
      provider: 'github',
      remoteUrl: 'https://github.com/acme/frontend.git',
      remoteRef: 'acme/frontend',
      cloneStatus: 'pending',
      localPath: null,
    });

    const ensureRepositoryCloneMock = vi.fn(async () => {
      const repository = getRepositoryByName(db, 'frontend');
      if (!repository) {
        throw new Error('Expected repository row.');
      }

      return {
        repository: {
          ...repository,
          cloneStatus: 'cloned' as const,
          localPath: '/tmp/alphred/repos/github/acme/frontend',
        },
        action: 'fetched' as const,
        sync: {
          mode: 'pull' as const,
          strategy: 'rebase' as const,
          branch: 'main',
          status: 'up_to_date' as const,
          conflictMessage: null,
        },
      };
    });

    const captured = createCapturedIo();

    const exitCode = await main(['repo', 'sync', 'frontend', '--strategy', 'rebase'], {
      dependencies: createDependencies(db, createUnusedProviderResolver(), {
        ensureRepositoryClone: ensureRepositoryCloneMock,
      }),
      io: captured.io,
    });

    expect(exitCode).toBe(0);
    expect(ensureRepositoryCloneMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sync: {
          mode: 'pull',
          strategy: 'rebase',
        },
      }),
    );
    expect(captured.stdout).toContain('Sync status: up_to_date (mode=pull, strategy=rebase, branch=main).');
  });

  it('prints an unavailable sync summary when repository sync metadata is missing', async () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    insertRepository(db, {
      name: 'frontend',
      provider: 'github',
      remoteUrl: 'https://github.com/acme/frontend.git',
      remoteRef: 'acme/frontend',
      cloneStatus: 'pending',
      localPath: null,
    });

    const ensureRepositoryCloneMock = vi.fn(async () => {
      const repository = getRepositoryByName(db, 'frontend');
      if (!repository) {
        throw new Error('Expected repository row.');
      }

      return {
        repository: {
          ...repository,
          cloneStatus: 'cloned' as const,
          localPath: '/tmp/alphred/repos/github/acme/frontend',
        },
        action: 'fetched' as const,
      };
    });

    const captured = createCapturedIo();

    const exitCode = await main(['repo', 'sync', 'frontend'], {
      dependencies: createDependencies(db, createUnusedProviderResolver(), {
        ensureRepositoryClone: ensureRepositoryCloneMock,
      }),
      io: captured.io,
    });

    expect(exitCode).toBe(0);
    expect(captured.stdout).toContain('Sync status unavailable.');
  });

  it('fails with usage error when repo sync strategy is invalid', async () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    const captured = createCapturedIo();

    const exitCode = await main(['repo', 'sync', 'frontend', '--strategy', 'invalid'], {
      dependencies: createDependencies(db, createUnusedProviderResolver()),
      io: captured.io,
    });

    expect(exitCode).toBe(2);
    expect(captured.stderr).toEqual([
      'Option "--strategy" must be one of: ff-only, merge, rebase.',
      'Usage: alphred repo sync <name> [--strategy <ff-only|merge|rebase>]',
    ]);
  });

  it('returns runtime error when sync reports conflicts', async () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    insertRepository(db, {
      name: 'frontend',
      provider: 'github',
      remoteUrl: 'https://github.com/acme/frontend.git',
      remoteRef: 'acme/frontend',
      cloneStatus: 'cloned',
      localPath: '/tmp/alphred/repos/github/acme/frontend',
    });

    const ensureRepositoryCloneMock = vi.fn(async () => {
      const repository = getRepositoryByName(db, 'frontend');
      if (!repository) {
        throw new Error('Expected repository row.');
      }

      return {
        repository,
        action: 'fetched' as const,
        sync: {
          mode: 'pull' as const,
          strategy: 'ff-only' as const,
          branch: 'main',
          status: 'conflicted' as const,
          conflictMessage: 'Sync conflict on branch "main" with strategy "ff-only": Not possible to fast-forward, aborting.',
        },
      };
    });

    const captured = createCapturedIo();
    const exitCode = await main(['repo', 'sync', 'frontend'], {
      dependencies: createDependencies(db, createUnusedProviderResolver(), {
        ensureRepositoryClone: ensureRepositoryCloneMock,
      }),
      io: captured.io,
    });

    expect(exitCode).toBe(4);
    expect(captured.stderr).toEqual([
      'Sync conflict on branch "main" with strategy "ff-only": Not possible to fast-forward, aborting.',
      'Repository "frontend" remains at "/tmp/alphred/repos/github/acme/frontend".',
    ]);
  });

  it('fails repo sync pre-flight when scm auth is missing', async () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    insertRepository(db, {
      name: 'frontend',
      provider: 'github',
      remoteUrl: 'https://github.com/acme/frontend.git',
      remoteRef: 'acme/frontend',
      cloneStatus: 'pending',
      localPath: null,
    });
    const ensureRepositoryCloneMock = vi.fn();
    const checkAuthMock = vi.fn(async (_environment?: NodeJS.ProcessEnv) => ({
      authenticated: false,
      error: 'Run "gh auth login" to authenticate GitHub CLI.',
    }));
    const createScmProviderMock = vi.fn((_config: ScmProviderConfig) => ({
      checkAuth: checkAuthMock,
    }));
    const captured = createCapturedIo({
      env: {
        ALPHRED_GH_TOKEN: 'repo-sync-preflight-token',
      },
    });

    const exitCode = await main(['repo', 'sync', 'frontend'], {
      dependencies: createDependencies(db, createUnusedProviderResolver(), {
        createScmProvider: createScmProviderMock,
        ensureRepositoryClone: ensureRepositoryCloneMock,
      }),
      io: captured.io,
    });

    expect(exitCode).toBe(4);
    expect(captured.stderr).toEqual([
      'Failed to execute repo sync: GitHub authentication is required.',
      'Run "gh auth login" to authenticate GitHub CLI.',
    ]);
    expect(checkAuthMock).toHaveBeenCalledWith(captured.io.env);
    expect(ensureRepositoryCloneMock).not.toHaveBeenCalled();
  });

  it('returns usage errors for invalid repo command inputs', async () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    const cases: readonly {
      args: string[];
      stderr: string[];
    }[] = [
      {
        args: ['repo'],
        stderr: ['Missing required repo subcommand.', 'Usage: alphred repo <add|list|show|remove|sync>'],
      },
      {
        args: ['repo', 'unknown'],
        stderr: ['Unknown repo subcommand "unknown".', 'Usage: alphred repo <add|list|show|remove|sync>'],
      },
      {
        args: ['repo', 'add', '--name', 'frontend'],
        stderr: ['One of "--github" or "--azure" is required.', 'Usage: alphred repo add --name <name> (--github <owner/repo> | --azure <org/project/repo>)'],
      },
      {
        args: ['repo', 'add', '--name', '  ', '--github', 'acme/frontend'],
        stderr: ['Repository name cannot be empty.', 'Usage: alphred repo add --name <name> (--github <owner/repo> | --azure <org/project/repo>)'],
      },
      {
        args: ['repo', 'show'],
        stderr: ['Missing required positional argument for "repo show".', 'Usage: alphred repo show <name>'],
      },
      {
        args: ['repo', 'remove', '--purge'],
        stderr: ['Missing required positional argument for "repo remove".', 'Usage: alphred repo remove <name> [--purge]'],
      },
      {
        args: ['repo', 'sync', 'frontend', '--force=yes'],
        stderr: [
          'Unknown option for "repo sync": --force',
          'Usage: alphred repo sync <name> [--strategy <ff-only|merge|rebase>]',
        ],
      },
    ];

    for (const testCase of cases) {
      const captured = createCapturedIo();
      const exitCode = await main(testCase.args, {
        dependencies: createDependencies(db, createUnusedProviderResolver()),
        io: captured.io,
      });

      expect(exitCode).toBe(2);
      expect(captured.stderr).toEqual(testCase.stderr);
    }
  });

  it('returns not-found for repo show/remove/sync on unknown repositories', async () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    const commands: readonly string[][] = [
      ['repo', 'show', 'missing'],
      ['repo', 'remove', 'missing'],
      ['repo', 'sync', 'missing'],
    ];

    for (const args of commands) {
      const captured = createCapturedIo();
      const exitCode = await main(args, {
        dependencies: createDependencies(db, createUnusedProviderResolver()),
        io: captured.io,
      });

      expect(exitCode).toBe(3);
      expect(captured.stderr).toEqual(['Repository "missing" was not found.']);
    }
  });
});

