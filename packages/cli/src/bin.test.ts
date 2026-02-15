import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ProviderEvent, ProviderRunOptions } from '@alphred/shared';
import { describe, expect, it } from 'vitest';
import {
  createDatabase,
  materializeWorkflowRunFromTree,
  migrateDatabase,
  promptTemplates,
  runNodes,
  treeNodes,
  workflowRuns,
  workflowTrees,
  type AlphredDatabase,
} from '@alphred/db';
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
): CliDependencies {
  return {
    openDatabase: () => db,
    migrateDatabase: database => migrateDatabase(database),
    resolveProvider,
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
      },
      io: captured.io,
    });

    expect(exitCode).toBe(3);
    expect(openedDatabasePaths).toEqual([absolutePath]);
  });

  it('returns usage exit code for invalid run command inputs', async () => {
    const cases: readonly {
      args: string[];
      stderr: string[];
    }[] = [
      {
        args: ['run'],
        stderr: ['Missing required option: --tree <tree_key>', 'Usage: alphred run --tree <tree_key>'],
      },
      {
        args: ['run', '--tree'],
        stderr: ['Option "--tree" requires a value.', 'Usage: alphred run --tree <tree_key>'],
      },
      {
        args: ['run', '--tree', 'design_tree', 'extra'],
        stderr: ['Unexpected positional arguments for "run": extra', 'Usage: alphred run --tree <tree_key>'],
      },
      {
        args: ['run', '--run', '1'],
        stderr: ['Unknown option for "run": --run', 'Usage: alphred run --tree <tree_key>'],
      },
      {
        args: ['run', '--tree', 'design_tree', '--tree', 'design_tree'],
        stderr: ['Option "--tree" cannot be provided more than once.', 'Usage: alphred run --tree <tree_key>'],
      },
      {
        args: ['run', '--tree='],
        stderr: ['Option "--tree" requires a value.', 'Usage: alphred run --tree <tree_key>'],
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
