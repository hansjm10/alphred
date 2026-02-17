import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ProviderEvent, ProviderRunOptions } from '@alphred/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  createDatabase,
  getRepositoryByName,
  insertRepository,
  insertRunWorktree,
  materializeWorkflowRunFromTree,
  migrateDatabase,
  promptTemplates,
  runNodes,
  treeNodes,
  workflowRuns,
  workflowTrees,
  type AlphredDatabase,
  type InsertRepositoryParams,
} from '@alphred/db';
import type { EnsureRepositoryCloneParams, EnsureRepositoryCloneResult } from '@alphred/git';
import type { RepositoryConfig } from '@alphred/shared';
import { isExecutedAsScript, main, runCliEntrypoint, type CliDependencies } from './bin.js';

type CapturedIo = {
  stdout: string[];
  stderr: string[];
  io: {
    stdout: (message: string) => void;
    stderr: (message: string) => void;
    cwd: string;
    env: NodeJS.ProcessEnv;
  };
};

function createCapturedIo(
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): CapturedIo {
  const stdout: string[] = [];
  const stderr: string[] = [];

  return {
    stdout,
    stderr,
    io: {
      stdout: message => stdout.push(message),
      stderr: message => stderr.push(message),
      cwd: options.cwd ?? '/work/alphred',
      env: options.env ?? {},
    },
  };
}

function createDependencies(
  db: AlphredDatabase,
  resolveProvider: CliDependencies['resolveProvider'],
  overrides: {
    ensureRepositoryClone?: CliDependencies['ensureRepositoryClone'];
    createWorktreeManager?: CliDependencies['createWorktreeManager'];
    removeDirectory?: CliDependencies['removeDirectory'];
  } = {},
): CliDependencies {
  const defaultEnsureRepositoryClone: CliDependencies['ensureRepositoryClone'] = async (
    params: EnsureRepositoryCloneParams,
  ): Promise<EnsureRepositoryCloneResult> => {
    const existing = getRepositoryByName(params.db, params.repository.name);
    let repository: RepositoryConfig;
    if (existing) {
      repository = existing;
    } else {
      repository = insertRepository(params.db, params.repository as InsertRepositoryParams);
    }

    return {
      repository: {
        ...repository,
        cloneStatus: 'cloned',
        localPath: repository.localPath ?? `/tmp/repos/${repository.provider}/${repository.remoteRef.replace(/\//g, '-')}`,
      },
      action: 'cloned',
    };
  };

  const defaultWorktreeManagerFactory: CliDependencies['createWorktreeManager'] = () => ({
    createRunWorktree: async () => {
      throw new Error('createRunWorktree should not be called in this test');
    },
    cleanupRun: async () => undefined,
  });

  return {
    openDatabase: () => db,
    migrateDatabase: database => migrateDatabase(database),
    resolveProvider,
    ensureRepositoryClone: overrides.ensureRepositoryClone ?? defaultEnsureRepositoryClone,
    createWorktreeManager: overrides.createWorktreeManager ?? defaultWorktreeManagerFactory,
    removeDirectory: overrides.removeDirectory ?? (async () => undefined),
  };
}

function createSuccessfulProviderResolver(): CliDependencies['resolveProvider'] {
  return () => ({
    async *run(_prompt: string, _options: ProviderRunOptions): AsyncIterable<ProviderEvent> {
      yield {
        type: 'assistant',
        content: 'Running node',
        timestamp: 1,
      };
      yield {
        type: 'result',
        content: 'decision: approved',
        timestamp: 2,
      };
    },
  });
}

function createAssertingProviderResolver(
  assertions: (options: ProviderRunOptions) => void,
): CliDependencies['resolveProvider'] {
  return () => ({
    async *run(_prompt: string, options: ProviderRunOptions): AsyncIterable<ProviderEvent> {
      assertions(options);
      yield {
        type: 'result',
        content: 'decision: approved',
        timestamp: 2,
      };
    },
  });
}

function createFailingProviderResolver(): CliDependencies['resolveProvider'] {
  return () => ({
    run(_prompt: string, _options: ProviderRunOptions): AsyncIterable<ProviderEvent> {
      return {
        [Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
          throw new Error('simulated provider failure');
        },
      };
    },
  });
}

function createUnusedProviderResolver(): CliDependencies['resolveProvider'] {
  return () => {
    throw new Error('provider should not be resolved in this test');
  };
}

function seedSingleNodeTree(db: AlphredDatabase, treeKey = 'design_tree'): void {
  const tree = db
    .insert(workflowTrees)
    .values({
      treeKey,
      version: 1,
      name: 'Design tree',
    })
    .returning({ id: workflowTrees.id })
    .get();

  const prompt = db
    .insert(promptTemplates)
    .values({
      templateKey: 'design_prompt',
      version: 1,
      content: 'Produce a design report',
      contentType: 'markdown',
    })
    .returning({ id: promptTemplates.id })
    .get();

  db.insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'design',
      nodeType: 'agent',
      provider: 'codex',
      promptTemplateId: prompt.id,
      sequenceIndex: 1,
    })
    .run();
}

function seedTwoNodeTree(db: AlphredDatabase, treeKey = 'design_tree'): void {
  const tree = db
    .insert(workflowTrees)
    .values({
      treeKey,
      version: 1,
      name: 'Design tree',
    })
    .returning({ id: workflowTrees.id })
    .get();

  const designPrompt = db
    .insert(promptTemplates)
    .values({
      templateKey: `${treeKey}_design_prompt`,
      version: 1,
      content: 'Produce a design report',
      contentType: 'markdown',
    })
    .returning({ id: promptTemplates.id })
    .get();

  const reviewPrompt = db
    .insert(promptTemplates)
    .values({
      templateKey: `${treeKey}_review_prompt`,
      version: 1,
      content: 'Review the design report',
      contentType: 'markdown',
    })
    .returning({ id: promptTemplates.id })
    .get();

  db.insert(treeNodes)
    .values([
      {
        workflowTreeId: tree.id,
        nodeKey: 'design',
        nodeType: 'agent',
        provider: 'codex',
        promptTemplateId: designPrompt.id,
        sequenceIndex: 1,
      },
      {
        workflowTreeId: tree.id,
        nodeKey: 'review',
        nodeType: 'agent',
        provider: 'codex',
        promptTemplateId: reviewPrompt.id,
        sequenceIndex: 2,
      },
    ])
    .run();
}

describe('CLI run/status commands', () => {
  it('executes "run --tree" and reports completed status for a successful run', async () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    seedSingleNodeTree(db, 'design_tree');
    const captured = createCapturedIo();

    const exitCode = await main(['run', '--tree', 'design_tree'], {
      dependencies: createDependencies(db, createSuccessfulProviderResolver()),
      io: captured.io,
    });

    expect(exitCode).toBe(0);
    expect(captured.stderr).toEqual([]);
    expect(captured.stdout.some(line => line.includes('status=completed'))).toBe(true);

    const persistedRun = db
      .select({
        status: workflowRuns.status,
      })
      .from(workflowRuns)
      .all()[0];

    expect(persistedRun?.status).toBe('completed');
  });

  it('returns not-found exit code when running an unknown tree key', async () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    const captured = createCapturedIo();

    const exitCode = await main(['run', '--tree', 'missing_tree'], {
      dependencies: createDependencies(db, createSuccessfulProviderResolver()),
      io: captured.io,
    });

    expect(exitCode).toBe(3);
    expect(captured.stderr).toEqual(['Workflow tree not found for key "missing_tree".']);
  });

  it('returns runtime failure exit code when provider execution fails', async () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    seedSingleNodeTree(db, 'design_tree');
    const captured = createCapturedIo();

    const exitCode = await main(['run', '--tree', 'design_tree'], {
      dependencies: createDependencies(db, createFailingProviderResolver()),
      io: captured.io,
    });

    expect(exitCode).toBe(4);
    expect(captured.stderr.some(line => line.includes('status=failed'))).toBe(true);

    const persistedRun = db
      .select({
        status: workflowRuns.status,
      })
      .from(workflowRuns)
      .all()[0];

    expect(persistedRun?.status).toBe('failed');
  });

  it('uses WorktreeManager when running with --repo and passes branch override', async () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    seedSingleNodeTree(db, 'design_tree');
    insertRepository(db, {
      name: 'frontend',
      provider: 'github',
      remoteUrl: 'https://github.com/acme/frontend.git',
      remoteRef: 'acme/frontend',
      defaultBranch: 'main',
      cloneStatus: 'cloned',
      localPath: '/tmp/alphred/repos/github/acme/frontend',
    });
    const captured = createCapturedIo();

    const createRunWorktree = vi.fn(async () => ({
      id: 101,
      runId: 1,
      repositoryId: 1,
      path: '/tmp/alphred/worktrees/fix-auth-bug',
      branch: 'fix/auth-bug',
      commitHash: 'abc123',
      createdAt: '2026-01-01T00:00:00.000Z',
    }));
    const cleanupRun = vi.fn(async () => undefined);
    const createWorktreeManager = vi.fn(() => ({
      createRunWorktree,
      cleanupRun,
    }));

    let observedWorkingDirectory = '';
    const exitCode = await main(['run', '--tree', 'design_tree', '--repo', 'frontend', '--branch', 'fix/auth-bug'], {
      dependencies: createDependencies(
        db,
        createAssertingProviderResolver(options => {
          observedWorkingDirectory = options.workingDirectory;
        }),
        {
          createWorktreeManager,
        },
      ),
      io: captured.io,
    });

    expect(exitCode).toBe(0);
    expect(createWorktreeManager).toHaveBeenCalledTimes(1);
    expect(createRunWorktree).toHaveBeenCalledWith({
      repoName: 'frontend',
      treeKey: 'design_tree',
      runId: expect.any(Number),
      branch: 'fix/auth-bug',
    });
    expect(cleanupRun).toHaveBeenCalledWith(expect.any(Number));
    expect(observedWorkingDirectory).toBe('/tmp/alphred/worktrees/fix-auth-bug');
  });

  it('returns runtime failure without materializing a run when --repo names an unknown repository', async () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    seedSingleNodeTree(db, 'design_tree');
    const captured = createCapturedIo();

    const exitCode = await main(['run', '--tree', 'design_tree', '--repo', 'missing'], {
      dependencies: createDependencies(db, createUnusedProviderResolver()),
      io: captured.io,
    });

    expect(exitCode).toBe(4);
    expect(captured.stderr).toEqual(['Failed to execute run: Repository "missing" was not found.']);
    expect(
      db.select({ id: workflowRuns.id })
        .from(workflowRuns)
        .all(),
    ).toEqual([]);
  });

  it('marks run cancelled when repository setup fails after run materialization', async () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    seedSingleNodeTree(db, 'design_tree');
    insertRepository(db, {
      name: 'frontend',
      provider: 'github',
      remoteUrl: 'https://github.com/acme/frontend.git',
      remoteRef: 'acme/frontend',
      defaultBranch: 'main',
      cloneStatus: 'cloned',
      localPath: '/tmp/alphred/repos/github/acme/frontend',
    });
    const captured = createCapturedIo();

    const createRunWorktree = vi.fn(async () => {
      throw new Error('simulated worktree setup failure');
    });
    const cleanupRun = vi.fn(async () => undefined);
    const createWorktreeManager = vi.fn(() => ({
      createRunWorktree,
      cleanupRun,
    }));

    const exitCode = await main(['run', '--tree', 'design_tree', '--repo', 'frontend'], {
      dependencies: createDependencies(db, createUnusedProviderResolver(), {
        createWorktreeManager,
      }),
      io: captured.io,
    });

    expect(exitCode).toBe(4);
    expect(captured.stderr).toEqual(['Failed to execute run: simulated worktree setup failure']);
    expect(cleanupRun).toHaveBeenCalledWith(expect.any(Number));
    expect(
      db.select({
        status: workflowRuns.status,
      })
        .from(workflowRuns)
        .all()[0]?.status,
    ).toBe('cancelled');
  });

  it('auto-registers github shorthand repositories for run --repo', async () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    seedSingleNodeTree(db, 'design_tree');
    const captured = createCapturedIo();

    const createRunWorktree = vi.fn(async () => ({
      id: 102,
      runId: 1,
      repositoryId: 1,
      path: '/tmp/alphred/worktrees/frontend',
      branch: 'alphred/design-tree/1',
      commitHash: 'abc123',
      createdAt: '2026-01-01T00:00:00.000Z',
    }));
    const createWorktreeManager = vi.fn(() => ({
      createRunWorktree,
      cleanupRun: vi.fn(async () => undefined),
    }));

    const exitCode = await main(['run', '--tree', 'design_tree', '--repo', 'github:acme/frontend'], {
      dependencies: createDependencies(db, createSuccessfulProviderResolver(), {
        createWorktreeManager,
      }),
      io: captured.io,
    });

    expect(exitCode).toBe(0);
    expect(createRunWorktree).toHaveBeenCalledWith({
      repoName: 'frontend',
      treeKey: 'design_tree',
      runId: expect.any(Number),
      branch: undefined,
    });
    const repository = getRepositoryByName(db, 'frontend');
    expect(repository).toBeDefined();
    expect(repository?.provider).toBe('github');
    expect(repository?.remoteRef).toBe('acme/frontend');
    expect(captured.stdout.some(line => line.includes('Auto-registered repository "frontend"'))).toBe(true);
  });

  it('renders workflow and node status from SQL state with "status --run"', async () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    seedSingleNodeTree(db, 'design_tree');
    const materialized = materializeWorkflowRunFromTree(db, { treeKey: 'design_tree' });
    const captured = createCapturedIo();

    const exitCode = await main(['status', '--run', String(materialized.run.id)], {
      dependencies: createDependencies(db, createUnusedProviderResolver()),
      io: captured.io,
    });

    expect(exitCode).toBe(0);
    expect(captured.stderr).toEqual([]);
    expect(captured.stdout.some(line => line.includes(`Run id=${materialized.run.id}`))).toBe(true);
    expect(captured.stdout.some(line => line.includes('Node status summary: pending=1 running=0 completed=0 failed=0 skipped=0 cancelled=0'))).toBe(true);
    expect(captured.stdout.some(line => line.includes('design: status=pending attempt=1'))).toBe(true);
  });

  it('accepts inline long-option values for run and status', async () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    seedSingleNodeTree(db, 'design_tree');
    const runCaptured = createCapturedIo();

    const runExitCode = await main(['run', '--tree=design_tree'], {
      dependencies: createDependencies(db, createSuccessfulProviderResolver()),
      io: runCaptured.io,
    });

    expect(runExitCode).toBe(0);
    expect(runCaptured.stderr).toEqual([]);

    const persistedRun = db
      .select({
        id: workflowRuns.id,
      })
      .from(workflowRuns)
      .all()[0];

    expect(persistedRun?.id).toBeTypeOf('number');

    const statusCaptured = createCapturedIo();
    const statusExitCode = await main(['status', `--run=${persistedRun?.id}`], {
      dependencies: createDependencies(db, createUnusedProviderResolver()),
      io: statusCaptured.io,
    });

    expect(statusExitCode).toBe(0);
    expect(statusCaptured.stderr).toEqual([]);
    expect(statusCaptured.stdout.some(line => line.includes(`Run id=${persistedRun?.id}`))).toBe(true);
  });

  it('shows latest attempt per node key in status output', async () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    seedTwoNodeTree(db, 'retry_tree');
    const materialized = materializeWorkflowRunFromTree(db, { treeKey: 'retry_tree' });
    const designTreeNode = db
      .select({
        id: treeNodes.id,
        nodeKey: treeNodes.nodeKey,
      })
      .from(treeNodes)
      .all()
      .find(node => node.nodeKey === 'design');

    expect(designTreeNode).toBeDefined();
    if (!designTreeNode) {
      return;
    }

    db.insert(runNodes)
      .values({
        workflowRunId: materialized.run.id,
        treeNodeId: designTreeNode.id,
        nodeKey: 'design',
        status: 'pending',
        sequenceIndex: 3,
        attempt: 2,
      })
      .run();

    const captured = createCapturedIo();
    const exitCode = await main(['status', '--run', String(materialized.run.id)], {
      dependencies: createDependencies(db, createUnusedProviderResolver()),
      io: captured.io,
    });

    expect(exitCode).toBe(0);
    expect(captured.stderr).toEqual([]);
    expect(captured.stdout.some(line => line.includes('Node status summary: pending=2 running=0 completed=0 failed=0 skipped=0 cancelled=0'))).toBe(true);
    expect(captured.stdout.some(line => line.includes('design: status=pending attempt=2'))).toBe(true);
    expect(captured.stdout.some(line => line.includes('review: status=pending attempt=1'))).toBe(true);
    expect(captured.stdout.some(line => line.includes('design: status=pending attempt=1'))).toBe(false);
  });

  it('returns not-found exit code for unknown status run id', async () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    const captured = createCapturedIo();

    const exitCode = await main(['status', '--run', '42'], {
      dependencies: createDependencies(db, createUnusedProviderResolver()),
      io: captured.io,
    });

    expect(exitCode).toBe(3);
    expect(captured.stderr).toEqual(['Workflow run id=42 was not found.']);
  });

  it('returns usage exit code for invalid run id input', async () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    const captured = createCapturedIo();

    const exitCode = await main(['status', '--run', 'abc'], {
      dependencies: createDependencies(db, createUnusedProviderResolver()),
      io: captured.io,
    });

    expect(exitCode).toBe(2);
    expect(captured.stderr).toEqual(['Invalid run id "abc". Run id must be a positive integer.']);
  });

  it('prints usage for help invocations and returns success', async () => {
    const cases = [[], ['help'], ['--help'], ['-h']];

    for (const args of cases) {
      const captured = createCapturedIo();
      const exitCode = await main(args, { io: captured.io });

      expect(exitCode).toBe(0);
      expect(captured.stderr).toEqual([]);
      expect(captured.stdout).toContain('Usage: alphred <command> [options]');
    }
  });

  it('returns usage error for unknown commands', async () => {
    const captured = createCapturedIo();

    const exitCode = await main(['unknown-command'], {
      io: captured.io,
    });

    expect(exitCode).toBe(2);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr[0]).toBe('Unknown command "unknown-command".');
    expect(captured.stderr).toContain('Usage: alphred <command> [options]');
  });

  it('resolves relative ALPHRED_DB_PATH from cwd before opening database', async () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    const openedDatabasePaths: string[] = [];
    const captured = createCapturedIo({
      cwd: '/tmp/alphred-workdir',
      env: {
        ALPHRED_DB_PATH: 'data/test.sqlite',
      },
    });

    const exitCode = await main(['status', '--run', '42'], {
      dependencies: {
        openDatabase: path => {
          openedDatabasePaths.push(path);
          return db;
        },
        migrateDatabase: database => migrateDatabase(database),
        resolveProvider: createUnusedProviderResolver(),
        ensureRepositoryClone: async () => {
          throw new Error('ensureRepositoryClone should not be called in this test');
        },
        createWorktreeManager: () => ({
          createRunWorktree: async () => {
            throw new Error('createRunWorktree should not be called in this test');
          },
          cleanupRun: async () => undefined,
        }),
        removeDirectory: async () => undefined,
      },
      io: captured.io,
    });

    expect(exitCode).toBe(3);
    expect(openedDatabasePaths).toEqual([resolve('/tmp/alphred-workdir', 'data/test.sqlite')]);
  });

  it('passes absolute ALPHRED_DB_PATH through unchanged', async () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    const openedDatabasePaths: string[] = [];
    const absolutePath = '/var/tmp/alphred-cli-test.sqlite';
    const captured = createCapturedIo({
      cwd: '/tmp/alphred-workdir',
      env: {
        ALPHRED_DB_PATH: absolutePath,
      },
    });

    const exitCode = await main(['status', '--run', '42'], {
      dependencies: {
        openDatabase: path => {
          openedDatabasePaths.push(path);
          return db;
        },
        migrateDatabase: database => migrateDatabase(database),
        resolveProvider: createUnusedProviderResolver(),
        ensureRepositoryClone: async () => {
          throw new Error('ensureRepositoryClone should not be called in this test');
        },
        createWorktreeManager: () => ({
          createRunWorktree: async () => {
            throw new Error('createRunWorktree should not be called in this test');
          },
          cleanupRun: async () => undefined,
        }),
        removeDirectory: async () => undefined,
      },
      io: captured.io,
    });

    expect(exitCode).toBe(3);
    expect(openedDatabasePaths).toEqual([absolutePath]);
  });

  it('returns usage exit code for invalid run command inputs', async () => {
    const runUsage = 'Usage: alphred run --tree <tree_key> [--repo <name|github:owner/repo|azure:org/project/repo>] [--branch <branch_name>]';
    const cases: readonly {
      args: string[];
      stderr: string[];
    }[] = [
      {
        args: ['run'],
        stderr: ['Missing required option: --tree <tree_key>', runUsage],
      },
      {
        args: ['run', '--tree'],
        stderr: ['Option "--tree" requires a value.', runUsage],
      },
      {
        args: ['run', '--tree', 'design_tree', 'extra'],
        stderr: ['Unexpected positional arguments for "run": extra', runUsage],
      },
      {
        args: ['run', '--run', '1'],
        stderr: ['Unknown option for "run": --run', runUsage],
      },
      {
        args: ['run', '--tree', 'design_tree', '--tree', 'design_tree'],
        stderr: ['Option "--tree" cannot be provided more than once.', runUsage],
      },
      {
        args: ['run', '--tree='],
        stderr: ['Option "--tree" requires a value.', runUsage],
      },
      {
        args: ['run', '--tree', 'design_tree', '--branch', 'fix/auth-bug'],
        stderr: ['Option "--branch" requires "--repo".', runUsage],
      },
    ];

    for (const testCase of cases) {
      const db = createDatabase(':memory:');
      migrateDatabase(db);
      const captured = createCapturedIo();

      const exitCode = await main(testCase.args, {
        dependencies: createDependencies(db, createUnusedProviderResolver()),
        io: captured.io,
      });

      expect(exitCode).toBe(2);
      expect(captured.stderr).toEqual(testCase.stderr);
    }
  });

  it('returns usage exit code for invalid status command inputs', async () => {
    const cases: readonly {
      args: string[];
      stderr: string[];
    }[] = [
      {
        args: ['status'],
        stderr: ['Missing required option: --run <run_id>', 'Usage: alphred status --run <run_id>'],
      },
      {
        args: ['status', '--run'],
        stderr: ['Option "--run" requires a value.', 'Usage: alphred status --run <run_id>'],
      },
      {
        args: ['status', '--run', '1', 'extra'],
        stderr: ['Unexpected positional arguments for "status": extra', 'Usage: alphred status --run <run_id>'],
      },
      {
        args: ['status', '--tree', 'design_tree'],
        stderr: ['Unknown option for "status": --tree', 'Usage: alphred status --run <run_id>'],
      },
      {
        args: ['status', '--run', '1', '--run', '2'],
        stderr: ['Option "--run" cannot be provided more than once.', 'Usage: alphred status --run <run_id>'],
      },
      {
        args: ['status', '--run='],
        stderr: ['Option "--run" requires a value.', 'Usage: alphred status --run <run_id>'],
      },
      {
        args: ['status', '--run=abc'],
        stderr: ['Invalid run id "abc". Run id must be a positive integer.'],
      },
    ];

    for (const testCase of cases) {
      const db = createDatabase(':memory:');
      migrateDatabase(db);
      const captured = createCapturedIo();

      const exitCode = await main(testCase.args, {
        dependencies: createDependencies(db, createUnusedProviderResolver()),
        io: captured.io,
      });

      expect(exitCode).toBe(2);
      expect(captured.stderr).toEqual(testCase.stderr);
    }
  });

  it('returns runtime failure for "list" without arguments', async () => {
    const captured = createCapturedIo();

    const exitCode = await main(['list'], {
      io: captured.io,
    });

    expect(exitCode).toBe(4);
    expect(captured.stderr).toEqual(['The "list" command is not implemented yet.']);
  });

  it('returns usage exit code for invalid list command inputs', async () => {
    const cases: readonly {
      args: string[];
      stderr: string[];
    }[] = [
      {
        args: ['list', 'extra'],
        stderr: ['Unexpected positional arguments for "list": extra', 'Usage: alphred list'],
      },
      {
        args: ['list', '--tree', 'design_tree'],
        stderr: ['Unknown option for "list": --tree', 'Usage: alphred list'],
      },
      {
        args: ['list', '--tree'],
        stderr: ['Option "--tree" requires a value.', 'Usage: alphred list'],
      },
    ];

    for (const testCase of cases) {
      const captured = createCapturedIo();

      const exitCode = await main(testCase.args, {
        io: captured.io,
      });

      expect(exitCode).toBe(2);
      expect(captured.stderr).toEqual(testCase.stderr);
    }
  });
});

describe('CLI repo commands', () => {
  it('adds github and azure repositories', async () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    const githubCaptured = createCapturedIo();

    const githubExitCode = await main(['repo', 'add', '--name', 'frontend', '--github', 'acme/frontend'], {
      dependencies: createDependencies(db, createUnusedProviderResolver()),
      io: githubCaptured.io,
    });

    expect(githubExitCode).toBe(0);
    expect(githubCaptured.stderr).toEqual([]);
    expect(githubCaptured.stdout).toContain('Registered repository "frontend" (github:acme/frontend).');

    const azureCaptured = createCapturedIo();
    const azureExitCode = await main(['repo', 'add', '--name', 'backend', '--azure', 'myorg/myproject/backend'], {
      dependencies: createDependencies(db, createUnusedProviderResolver()),
      io: azureCaptured.io,
    });

    expect(azureExitCode).toBe(0);
    expect(azureCaptured.stderr).toEqual([]);
    expect(azureCaptured.stdout).toContain(
      'Registered repository "backend" (azure-devops:myorg/myproject/backend).',
    );
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
    expect(ensureRepositoryCloneMock).toHaveBeenCalledTimes(1);
    expect(captured.stdout.some(line => line.includes('Repository "frontend" cloned'))).toBe(true);
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
        args: ['repo', 'show'],
        stderr: ['Missing required positional argument for "repo show".', 'Usage: alphred repo show <name>'],
      },
      {
        args: ['repo', 'remove', '--purge'],
        stderr: ['Missing required positional argument for "repo remove".', 'Usage: alphred repo remove <name> [--purge]'],
      },
      {
        args: ['repo', 'sync', 'frontend', '--force=yes'],
        stderr: ['Unknown option for "repo sync": --force', 'Usage: alphred repo sync <name>'],
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

describe('CLI script entrypoint behavior', () => {
  it('identifies matching script and module paths', () => {
    const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), 'bin.ts');
    expect(isExecutedAsScript(scriptPath, pathToFileURL(scriptPath).href)).toBe(true);
    expect(isExecutedAsScript(undefined, pathToFileURL(scriptPath).href)).toBe(false);
  });

  it('calls runtime.exit for non-zero command results', async () => {
    const exitCodes: number[] = [];
    const captured = createCapturedIo();

    await runCliEntrypoint(
      {
        argv: ['node', 'alphred', 'unknown-command'],
        exit: code => exitCodes.push(code),
      },
      { io: captured.io },
    );

    expect(exitCodes).toEqual([2]);
    expect(captured.stderr[0]).toBe('Unknown command "unknown-command".');
  });

  it('does not call runtime.exit for successful command results', async () => {
    const exitCodes: number[] = [];
    const captured = createCapturedIo();

    await runCliEntrypoint(
      {
        argv: ['node', 'alphred', 'help'],
        exit: code => exitCodes.push(code),
      },
      { io: captured.io },
    );

    expect(exitCodes).toEqual([]);
    expect(captured.stderr).toEqual([]);
    expect(captured.stdout).toContain('Usage: alphred <command> [options]');
  });
});
