import type { ProviderEvent, ProviderRunOptions } from '@alphred/shared';
import { describe, expect, it } from 'vitest';
import {
  createDatabase,
  materializeWorkflowRunFromTree,
  migrateDatabase,
  promptTemplates,
  treeNodes,
  workflowRuns,
  workflowTrees,
  type AlphredDatabase,
} from '@alphred/db';
import { main, type CliDependencies } from './bin.js';

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

function createCapturedIo(): CapturedIo {
  const stdout: string[] = [];
  const stderr: string[] = [];

  return {
    stdout,
    stderr,
    io: {
      stdout: message => stdout.push(message),
      stderr: message => stderr.push(message),
      cwd: '/work/alphred',
      env: {},
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
});
