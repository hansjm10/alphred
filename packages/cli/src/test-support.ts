import {
  getRepositoryByName,
  insertRepository,
  migrateDatabase,
  promptTemplates,
  treeNodes,
  workflowTrees,
  type AlphredDatabase,
  type InsertRepositoryParams,
} from '@alphred/db';
import type { EnsureRepositoryCloneParams, EnsureRepositoryCloneResult, ScmProviderConfig } from '@alphred/git';
import type { ProviderEvent, ProviderRunOptions, RepositoryConfig } from '@alphred/shared';
import type { CliDependencies } from './types.js';

export type CapturedIo = {
  stdout: string[];
  stderr: string[];
  io: {
    stdout: (message: string) => void;
    stderr: (message: string) => void;
    cwd: string;
    env: NodeJS.ProcessEnv;
  };
};

export function createCapturedIo(
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

export function createDependencies(
  db: AlphredDatabase,
  resolveProvider: CliDependencies['resolveProvider'],
  overrides: {
    createScmProvider?: CliDependencies['createScmProvider'];
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
        localPath: repository.localPath ?? `/tmp/repos/${repository.provider}/${repository.remoteRef.split('/').join('-')}`,
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

  const defaultCreateScmProvider: CliDependencies['createScmProvider'] = (_config: ScmProviderConfig) => ({
    checkAuth: async () => ({
      authenticated: true,
    }),
  });

  return {
    openDatabase: () => db,
    migrateDatabase: database => migrateDatabase(database),
    resolveProvider,
    createScmProvider: overrides.createScmProvider ?? defaultCreateScmProvider,
    ensureRepositoryClone: overrides.ensureRepositoryClone ?? defaultEnsureRepositoryClone,
    createWorktreeManager: overrides.createWorktreeManager ?? defaultWorktreeManagerFactory,
    removeDirectory: overrides.removeDirectory ?? (async () => undefined),
  };
}

export function createSuccessfulProviderResolver(): CliDependencies['resolveProvider'] {
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

export function createAssertingProviderResolver(
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

export function createFailingProviderResolver(): CliDependencies['resolveProvider'] {
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

export function createUnusedProviderResolver(): CliDependencies['resolveProvider'] {
  return () => {
    throw new Error('provider should not be resolved in this test');
  };
}

export function seedSingleNodeTree(db: AlphredDatabase, treeKey = 'design_tree'): void {
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

export function seedTwoNodeTree(db: AlphredDatabase, treeKey = 'design_tree'): void {
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
