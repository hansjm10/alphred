import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createDatabase,
  getRepositoryByName,
  insertRepository,
  materializeWorkflowRunFromTree,
  migrateDatabase,
  runNodes,
  treeNodes,
  transitionWorkflowRunStatus,
  workflowRuns,
} from '@alphred/db';
import type { ScmProviderConfig } from '@alphred/git';
import { main } from '../bin.js';
import {
  createAssertingProviderResolver,
  createCapturedIo,
  createDependencies,
  createFailingProviderResolver,
  createSuccessfulProviderResolver,
  createUnusedProviderResolver,
  seedSingleNodeTree,
  seedTwoNodeTree,
} from '../test-support.js';

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

  it('executes one attempt when run uses single-node scope', async () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    seedTwoNodeTree(db, 'design_tree');
    const captured = createCapturedIo();

    const exitCode = await main(['run', '--tree', 'design_tree', '--execution-scope', 'single_node'], {
      dependencies: createDependencies(db, createSuccessfulProviderResolver()),
      io: captured.io,
    });

    expect(exitCode).toBe(0);
    expect(captured.stderr).toEqual([]);
    expect(captured.stdout.some(line => line.includes('executed_nodes=1'))).toBe(true);

    const persistedRun = db
      .select({
        status: workflowRuns.status,
      })
      .from(workflowRuns)
      .all()[0];
    expect(persistedRun?.status).toBe('completed');

    const latestNodeStatuses = db
      .select({
        nodeKey: runNodes.nodeKey,
        status: runNodes.status,
        sequenceIndex: runNodes.sequenceIndex,
      })
      .from(runNodes)
      .orderBy(runNodes.sequenceIndex)
      .all();
    expect(latestNodeStatuses).toEqual([
      {
        nodeKey: 'design',
        status: 'completed',
        sequenceIndex: 1,
      },
      {
        nodeKey: 'review',
        status: 'pending',
        sequenceIndex: 2,
      },
    ]);
  });

  it('returns usage error when single-node node_key selector is invalid', async () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    seedSingleNodeTree(db, 'design_tree');
    const captured = createCapturedIo();

    const exitCode = await main(
      [
        'run',
        '--tree',
        'design_tree',
        '--execution-scope',
        'single_node',
        '--node-selector',
        'node_key',
        '--node-key',
        'missing-node',
      ],
      {
        dependencies: createDependencies(db, createSuccessfulProviderResolver()),
        io: captured.io,
      },
    );

    expect(exitCode).toBe(2);
    expect(captured.stderr).toEqual([
      'Node selector "node_key" did not match any node for key "missing-node" in workflow run id=1.',
    ]);
    expect(
      db.select({
        status: workflowRuns.status,
      })
        .from(workflowRuns)
        .all()[0]?.status,
    ).toBe('cancelled');
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
    const createScmProviderMock = vi.fn((_config: ScmProviderConfig) => ({
      checkAuth: async () => ({
        authenticated: true,
      }),
    }));

    let observedWorkingDirectory = '';
    const exitCode = await main(['run', '--tree', 'design_tree', '--repo', 'frontend', '--branch', 'fix/auth-bug'], {
      dependencies: createDependencies(
        db,
        createAssertingProviderResolver(options => {
          observedWorkingDirectory = options.workingDirectory;
        }),
        {
          createScmProvider: createScmProviderMock,
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
    expect(createScmProviderMock).toHaveBeenCalledWith({
      kind: 'github',
      repo: 'acme/frontend',
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

  it('fails run --repo pre-flight when scm auth is missing', async () => {
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
    const checkAuthMock = vi.fn(async (_environment?: NodeJS.ProcessEnv) => ({
      authenticated: false,
      error: 'Run "gh auth login" to authenticate GitHub CLI.',
    }));
    const createScmProviderMock = vi.fn((_config: ScmProviderConfig) => ({
      checkAuth: checkAuthMock,
    }));
    const captured = createCapturedIo({
      env: {
        ALPHRED_GH_TOKEN: 'run-preflight-token',
      },
    });

    const exitCode = await main(['run', '--tree', 'design_tree', '--repo', 'frontend'], {
      dependencies: createDependencies(db, createUnusedProviderResolver(), {
        createScmProvider: createScmProviderMock,
      }),
      io: captured.io,
    });

    expect(exitCode).toBe(4);
    expect(captured.stderr).toEqual([
      'Failed to execute run --repo: GitHub authentication is required.',
      'Run "gh auth login" to authenticate GitHub CLI.',
    ]);
    expect(createScmProviderMock).toHaveBeenCalledWith({
      kind: 'github',
      repo: 'acme/frontend',
    });
    expect(checkAuthMock).toHaveBeenCalledWith(captured.io.env);
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

  it('applies pause/resume/cancel lifecycle controls and prints machine-readable results', async () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    seedSingleNodeTree(db, 'design_tree');
    const materialized = materializeWorkflowRunFromTree(db, { treeKey: 'design_tree' });
    transitionWorkflowRunStatus(db, {
      workflowRunId: materialized.run.id,
      expectedFrom: 'pending',
      to: 'running',
    });

    const pauseCaptured = createCapturedIo();
    const pauseExitCode = await main(['run', 'pause', '--run', String(materialized.run.id)], {
      dependencies: createDependencies(db, createUnusedProviderResolver()),
      io: pauseCaptured.io,
    });

    expect(pauseExitCode).toBe(0);
    expect(pauseCaptured.stderr).toEqual([]);
    expect(pauseCaptured.stdout).toHaveLength(1);
    expect(JSON.parse(pauseCaptured.stdout[0] ?? '')).toEqual({
      action: 'pause',
      outcome: 'applied',
      workflowRunId: materialized.run.id,
      previousRunStatus: 'running',
      runStatus: 'paused',
      retriedRunNodeIds: [],
    });

    const resumeCaptured = createCapturedIo();
    const resumeExitCode = await main(['run', 'resume', '--run', String(materialized.run.id)], {
      dependencies: createDependencies(db, createUnusedProviderResolver()),
      io: resumeCaptured.io,
    });

    expect(resumeExitCode).toBe(0);
    expect(resumeCaptured.stderr).toEqual([]);
    expect(resumeCaptured.stdout).toHaveLength(1);
    expect(JSON.parse(resumeCaptured.stdout[0] ?? '')).toEqual({
      action: 'resume',
      outcome: 'applied',
      workflowRunId: materialized.run.id,
      previousRunStatus: 'paused',
      runStatus: 'running',
      retriedRunNodeIds: [],
    });

    const cancelCaptured = createCapturedIo();
    const cancelExitCode = await main(['run', 'cancel', '--run', String(materialized.run.id)], {
      dependencies: createDependencies(db, createUnusedProviderResolver()),
      io: cancelCaptured.io,
    });

    expect(cancelExitCode).toBe(0);
    expect(cancelCaptured.stderr).toEqual([]);
    expect(cancelCaptured.stdout).toHaveLength(1);
    expect(JSON.parse(cancelCaptured.stdout[0] ?? '')).toEqual({
      action: 'cancel',
      outcome: 'applied',
      workflowRunId: materialized.run.id,
      previousRunStatus: 'running',
      runStatus: 'cancelled',
      retriedRunNodeIds: [],
    });
  });

  it('retries a failed run and reports retried run-node ids', async () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    seedSingleNodeTree(db, 'design_tree');

    const runCaptured = createCapturedIo();
    const runExitCode = await main(['run', '--tree', 'design_tree'], {
      dependencies: createDependencies(db, createFailingProviderResolver()),
      io: runCaptured.io,
    });

    expect(runExitCode).toBe(4);
    const failedRun = db
      .select({
        id: workflowRuns.id,
        status: workflowRuns.status,
      })
      .from(workflowRuns)
      .all()[0];
    expect(failedRun?.status).toBe('failed');
    expect(failedRun?.id).toBeTypeOf('number');
    if (!failedRun) {
      return;
    }

    const failedRunNode = db
      .select({
        id: runNodes.id,
        status: runNodes.status,
      })
      .from(runNodes)
      .all()[0];
    expect(failedRunNode?.status).toBe('failed');
    if (!failedRunNode) {
      return;
    }

    const retryCaptured = createCapturedIo();
    const retryExitCode = await main(['run', 'retry', '--run', String(failedRun.id)], {
      dependencies: createDependencies(db, createUnusedProviderResolver()),
      io: retryCaptured.io,
    });

    expect(retryExitCode).toBe(0);
    expect(retryCaptured.stderr).toEqual([]);
    expect(retryCaptured.stdout).toHaveLength(1);
    expect(JSON.parse(retryCaptured.stdout[0] ?? '')).toEqual({
      action: 'retry',
      outcome: 'applied',
      workflowRunId: failedRun.id,
      previousRunStatus: 'failed',
      runStatus: 'running',
      retriedRunNodeIds: [failedRunNode.id],
    });

    expect(
      db.select({
        status: workflowRuns.status,
      })
        .from(workflowRuns)
        .all()[0]?.status,
    ).toBe('running');
    expect(
      db.select({
        status: runNodes.status,
        attempt: runNodes.attempt,
      })
        .from(runNodes)
        .all()[0],
    ).toEqual({
      status: 'pending',
      attempt: 2,
    });
  });

  it('returns not-found exit code for unknown run control run ids', async () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    const captured = createCapturedIo();

    const exitCode = await main(['run', 'cancel', '--run', '99'], {
      dependencies: createDependencies(db, createUnusedProviderResolver()),
      io: captured.io,
    });

    expect(exitCode).toBe(3);
    expect(captured.stderr).toEqual(['Workflow run id=99 was not found.']);
  });

  it('returns runtime failure with typed control details for invalid transitions', async () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    seedSingleNodeTree(db, 'design_tree');
    const materialized = materializeWorkflowRunFromTree(db, { treeKey: 'design_tree' });
    const captured = createCapturedIo();

    const exitCode = await main(['run', 'pause', '--run', String(materialized.run.id)], {
      dependencies: createDependencies(db, createUnusedProviderResolver()),
      io: captured.io,
    });

    expect(exitCode).toBe(4);
    expect(captured.stderr).toEqual([
      `Cannot pause workflow run id=${materialized.run.id} from status "pending". Expected status "running".`,
      'Control failure: code=WORKFLOW_RUN_CONTROL_INVALID_TRANSITION action=pause runStatus=pending.',
    ]);
  });

  it('returns runtime failure for retry when failed run has no failed nodes', async () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    seedSingleNodeTree(db, 'design_tree');
    const materialized = materializeWorkflowRunFromTree(db, { treeKey: 'design_tree' });
    transitionWorkflowRunStatus(db, {
      workflowRunId: materialized.run.id,
      expectedFrom: 'pending',
      to: 'running',
    });
    transitionWorkflowRunStatus(db, {
      workflowRunId: materialized.run.id,
      expectedFrom: 'running',
      to: 'failed',
    });
    const captured = createCapturedIo();

    const exitCode = await main(['run', 'retry', '--run', String(materialized.run.id)], {
      dependencies: createDependencies(db, createUnusedProviderResolver()),
      io: captured.io,
    });

    expect(exitCode).toBe(4);
    expect(captured.stderr).toEqual([
      `Workflow run id=${materialized.run.id} is failed but has no failed run nodes to retry.`,
      'Control failure: code=WORKFLOW_RUN_CONTROL_RETRY_TARGETS_NOT_FOUND action=retry runStatus=failed.',
    ]);
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
        createScmProvider: () => ({
          checkAuth: async () => ({
            authenticated: true,
          }),
        }),
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
        createScmProvider: () => ({
          checkAuth: async () => ({
            authenticated: true,
          }),
        }),
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
    const runUsage =
      'Usage: alphred run --tree <tree_key> [--repo <name|github:owner/repo|azure:org/project/repo>] [--branch <branch_name>] [--execution-scope <full|single_node>] [--node-selector <next_runnable|node_key>] [--node-key <node_key>]';
    const runPauseUsage = 'Usage: alphred run pause --run <run_id>';
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
        args: ['run', '--tree', 'design_tree', '--repo', '   '],
        stderr: ['Option "--repo" requires a value.', runUsage],
      },
      {
        args: ['run', '--tree', 'design_tree', '--repo', 'frontend', '--branch', '   '],
        stderr: ['Option "--branch" requires a value.', runUsage],
      },
      {
        args: ['run', '--tree', 'design_tree', '--branch', 'fix/auth-bug'],
        stderr: ['Option "--branch" requires "--repo".', runUsage],
      },
      {
        args: ['run', '--tree', 'design_tree', '--execution-scope', 'partial'],
        stderr: ['Option "--execution-scope" must be "full" or "single_node".', runUsage],
      },
      {
        args: ['run', '--tree', 'design_tree', '--node-selector', 'next_runnable'],
        stderr: ['Option "--node-selector" requires "--execution-scope single_node".', runUsage],
      },
      {
        args: ['run', '--tree', 'design_tree', '--node-key', 'design'],
        stderr: ['Option "--node-key" requires "--execution-scope single_node".', runUsage],
      },
      {
        args: ['run', '--tree', 'design_tree', '--execution-scope', 'single_node', '--node-selector', 'later'],
        stderr: ['Option "--node-selector" must be "next_runnable" or "node_key".', runUsage],
      },
      {
        args: ['run', '--tree', 'design_tree', '--execution-scope', 'single_node', '--node-selector', 'node_key'],
        stderr: ['Option "--node-key" is required when "--node-selector node_key" is used.', runUsage],
      },
      {
        args: [
          'run',
          '--tree',
          'design_tree',
          '--execution-scope',
          'single_node',
          '--node-selector',
          'next_runnable',
          '--node-key',
          'design',
        ],
        stderr: ['Option "--node-key" requires "--node-selector node_key".', runUsage],
      },
      {
        args: ['run', 'pause'],
        stderr: ['Missing required option: --run <run_id>', runPauseUsage],
      },
      {
        args: ['run', 'pause', '--run'],
        stderr: ['Option "--run" requires a value.', runPauseUsage],
      },
      {
        args: ['run', 'pause', '--run', '1', 'extra'],
        stderr: ['Unexpected positional arguments for "run pause": extra', runPauseUsage],
      },
      {
        args: ['run', 'pause', '--tree', 'design_tree'],
        stderr: ['Unknown option for "run pause": --tree', runPauseUsage],
      },
      {
        args: ['run', 'pause', '--run', '1', '--run', '2'],
        stderr: ['Option "--run" cannot be provided more than once.', runPauseUsage],
      },
      {
        args: ['run', 'pause', '--run='],
        stderr: ['Option "--run" requires a value.', runPauseUsage],
      },
      {
        args: ['run', 'pause', '--run=abc'],
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
