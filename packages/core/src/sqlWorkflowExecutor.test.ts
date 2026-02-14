import { eq } from 'drizzle-orm';
import type { ProviderEvent, ProviderRunOptions } from '@alphred/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  createDatabase,
  guardDefinitions,
  materializeWorkflowRunFromTree,
  migrateDatabase,
  phaseArtifacts,
  promptTemplates,
  runNodes,
  treeEdges,
  treeNodes,
  workflowRuns,
  workflowTrees,
} from '@alphred/db';
import { createSqlWorkflowExecutor } from './sqlWorkflowExecutor.js';

function createProvider(events: ProviderEvent[]) {
  return {
    async *run(_prompt: string, _options: ProviderRunOptions): AsyncIterable<ProviderEvent> {
      for (const event of events) {
        yield event;
      }
    },
  };
}

function seedSingleAgentRun() {
  const db = createDatabase(':memory:');
  migrateDatabase(db);

  const tree = db
    .insert(workflowTrees)
    .values({
      treeKey: 'design_tree',
      version: 1,
      name: 'Design Tree',
    })
    .returning({ id: workflowTrees.id })
    .get();

  const prompt = db
    .insert(promptTemplates)
    .values({
      templateKey: 'design_prompt',
      version: 1,
      content: 'Create a design report',
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

  const materialized = materializeWorkflowRunFromTree(db, { treeKey: 'design_tree' });
  return {
    db,
    runId: materialized.run.id,
    runNodeId: materialized.runNodes[0].id,
  };
}

function seedSingleAgentRunWithoutPromptTemplate() {
  const db = createDatabase(':memory:');
  migrateDatabase(db);

  const tree = db
    .insert(workflowTrees)
    .values({
      treeKey: 'design_tree_without_prompt',
      version: 1,
      name: 'Design Tree Without Prompt',
    })
    .returning({ id: workflowTrees.id })
    .get();

  db.insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'design',
      nodeType: 'agent',
      provider: 'codex',
      sequenceIndex: 1,
    })
    .run();

  const materialized = materializeWorkflowRunFromTree(db, {
    treeKey: 'design_tree_without_prompt',
  });

  return {
    db,
    runId: materialized.run.id,
    runNodeId: materialized.runNodes[0].id,
  };
}

function seedSingleHumanNodeRun() {
  const db = createDatabase(':memory:');
  migrateDatabase(db);

  const tree = db
    .insert(workflowTrees)
    .values({
      treeKey: 'human_tree',
      version: 1,
      name: 'Human Tree',
    })
    .returning({ id: workflowTrees.id })
    .get();

  db.insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'human_review',
      nodeType: 'human',
      sequenceIndex: 1,
    })
    .run();

  const materialized = materializeWorkflowRunFromTree(db, {
    treeKey: 'human_tree',
  });

  return {
    db,
    runId: materialized.run.id,
    runNodeId: materialized.runNodes[0].id,
  };
}

function seedGuardedCycleRun() {
  const db = createDatabase(':memory:');
  migrateDatabase(db);

  const tree = db
    .insert(workflowTrees)
    .values({
      treeKey: 'guarded_cycle_tree',
      version: 1,
      name: 'Guarded Cycle Tree',
    })
    .returning({ id: workflowTrees.id })
    .get();

  const prompt = db
    .insert(promptTemplates)
    .values({
      templateKey: 'guarded_cycle_prompt',
      version: 1,
      content: 'Draft report',
      contentType: 'markdown',
    })
    .returning({ id: promptTemplates.id })
    .get();

  const guard = db
    .insert(guardDefinitions)
    .values({
      guardKey: 'always_true',
      version: 1,
      expression: { operator: 'literal', value: true },
      description: 'Test guard for non-auto transition',
    })
    .returning({ id: guardDefinitions.id })
    .get();

  const nodeA = db
    .insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'a',
      nodeType: 'agent',
      provider: 'codex',
      promptTemplateId: prompt.id,
      sequenceIndex: 1,
    })
    .returning({ id: treeNodes.id })
    .get();

  const nodeB = db
    .insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'b',
      nodeType: 'agent',
      provider: 'codex',
      promptTemplateId: prompt.id,
      sequenceIndex: 2,
    })
    .returning({ id: treeNodes.id })
    .get();

  db.insert(treeEdges)
    .values([
      {
        workflowTreeId: tree.id,
        sourceNodeId: nodeA.id,
        targetNodeId: nodeB.id,
        priority: 0,
        auto: 0,
        guardDefinitionId: guard.id,
      },
      {
        workflowTreeId: tree.id,
        sourceNodeId: nodeB.id,
        targetNodeId: nodeA.id,
        priority: 0,
        auto: 0,
        guardDefinitionId: guard.id,
      },
    ])
    .run();

  const materialized = materializeWorkflowRunFromTree(db, {
    treeKey: 'guarded_cycle_tree',
  });

  return {
    db,
    runId: materialized.run.id,
  };
}

describe('createSqlWorkflowExecutor', () => {
  it('executes runnable nodes, persists artifacts, and completes the run on success', async () => {
    const { db, runId, runNodeId } = seedSingleAgentRun();
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () =>
        createProvider([
          { type: 'system', content: 'start', timestamp: 100 },
          { type: 'usage', content: '', timestamp: 101, metadata: { totalTokens: 42 } },
          { type: 'result', content: 'Design report body', timestamp: 102 },
        ]),
    });

    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result.executedNodes).toBe(1);
    expect(result.finalStep).toEqual({
      outcome: 'run_terminal',
      workflowRunId: runId,
      runStatus: 'completed',
    });

    const persistedRun = db
      .select({
        status: workflowRuns.status,
        startedAt: workflowRuns.startedAt,
        completedAt: workflowRuns.completedAt,
      })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .get();

    expect(persistedRun).toBeDefined();
    if (!persistedRun) {
      throw new Error('Expected persisted workflow run row.');
    }

    expect(persistedRun.status).toBe('completed');
    expect(persistedRun.startedAt).not.toBeNull();
    expect(persistedRun.completedAt).not.toBeNull();

    const persistedRunNode = db
      .select({
        status: runNodes.status,
        startedAt: runNodes.startedAt,
        completedAt: runNodes.completedAt,
      })
      .from(runNodes)
      .where(eq(runNodes.id, runNodeId))
      .get();

    expect(persistedRunNode).toBeDefined();
    if (!persistedRunNode) {
      throw new Error('Expected persisted run-node row.');
    }

    expect(persistedRunNode.status).toBe('completed');
    expect(persistedRunNode.startedAt).not.toBeNull();
    expect(persistedRunNode.completedAt).not.toBeNull();

    const artifacts = db
      .select({
        artifactType: phaseArtifacts.artifactType,
        contentType: phaseArtifacts.contentType,
        content: phaseArtifacts.content,
      })
      .from(phaseArtifacts)
      .where(eq(phaseArtifacts.runNodeId, runNodeId))
      .all();

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toEqual({
      artifactType: 'report',
      contentType: 'markdown',
      content: 'Design report body',
    });
  });

  it('fails deterministically when provider stream misses a result event and persists failure state', async () => {
    const { db, runId, runNodeId } = seedSingleAgentRun();
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () =>
        createProvider([
          { type: 'system', content: 'start', timestamp: 100 },
          { type: 'assistant', content: 'partial response', timestamp: 101 },
        ]),
    });

    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result.executedNodes).toBe(1);
    expect(result.finalStep).toEqual({
      outcome: 'run_terminal',
      workflowRunId: runId,
      runStatus: 'failed',
    });

    const persistedRun = db
      .select({
        status: workflowRuns.status,
        completedAt: workflowRuns.completedAt,
      })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .get();

    expect(persistedRun).toBeDefined();
    if (!persistedRun) {
      throw new Error('Expected persisted workflow run row.');
    }

    expect(persistedRun.status).toBe('failed');
    expect(persistedRun.completedAt).not.toBeNull();

    const persistedRunNode = db
      .select({
        status: runNodes.status,
        completedAt: runNodes.completedAt,
      })
      .from(runNodes)
      .where(eq(runNodes.id, runNodeId))
      .get();

    expect(persistedRunNode).toBeDefined();
    if (!persistedRunNode) {
      throw new Error('Expected persisted run-node row.');
    }

    expect(persistedRunNode.status).toBe('failed');
    expect(persistedRunNode.completedAt).not.toBeNull();

    const artifacts = db
      .select({
        artifactType: phaseArtifacts.artifactType,
        contentType: phaseArtifacts.contentType,
        content: phaseArtifacts.content,
      })
      .from(phaseArtifacts)
      .where(eq(phaseArtifacts.runNodeId, runNodeId))
      .all();

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].artifactType).toBe('log');
    expect(artifacts[0].contentType).toBe('text');
    expect(artifacts[0].content).toContain('without a result event');
  });

  it('returns blocked when pending nodes exist but none are runnable', async () => {
    const { db, runId } = seedGuardedCycleRun();
    const resolveProvider = vi.fn(() => createProvider([]));
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider,
    });

    const step = await executor.executeNextRunnableNode({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(step).toEqual({
      outcome: 'blocked',
      workflowRunId: runId,
      runStatus: 'running',
    });
    expect(resolveProvider).not.toHaveBeenCalled();

    const persistedRun = db
      .select({
        status: workflowRuns.status,
        startedAt: workflowRuns.startedAt,
        completedAt: workflowRuns.completedAt,
      })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .get();

    expect(persistedRun).toBeDefined();
    if (!persistedRun) {
      throw new Error('Expected persisted workflow run row.');
    }

    expect(persistedRun.status).toBe('running');
    expect(persistedRun.startedAt).not.toBeNull();
    expect(persistedRun.completedAt).toBeNull();

    const pendingNodes = db
      .select({
        status: runNodes.status,
      })
      .from(runNodes)
      .where(eq(runNodes.workflowRunId, runId))
      .all();

    expect(pendingNodes).toHaveLength(2);
    expect(pendingNodes.every((node) => node.status === 'pending')).toBe(true);
  });

  it('defaults persisted artifact content type to markdown when prompt content type is absent', async () => {
    const { db, runId, runNodeId } = seedSingleAgentRunWithoutPromptTemplate();
    let observedPrompt: string | undefined;
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () => ({
        async *run(prompt: string): AsyncIterable<ProviderEvent> {
          observedPrompt = prompt;
          yield { type: 'result', content: 'Generated report', timestamp: 10 };
        },
      }),
    });

    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result.finalStep).toEqual({
      outcome: 'run_terminal',
      workflowRunId: runId,
      runStatus: 'completed',
    });
    expect(observedPrompt).toBe('');

    const artifacts = db
      .select({
        artifactType: phaseArtifacts.artifactType,
        contentType: phaseArtifacts.contentType,
        content: phaseArtifacts.content,
      })
      .from(phaseArtifacts)
      .where(eq(phaseArtifacts.runNodeId, runNodeId))
      .all();

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toEqual({
      artifactType: 'report',
      contentType: 'markdown',
      content: 'Generated report',
    });
  });

  it('records failure artifact and terminal statuses when a non-agent node is selected', async () => {
    const { db, runId, runNodeId } = seedSingleHumanNodeRun();
    const resolveProvider = vi.fn(() => createProvider([]));
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider,
    });

    const result = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: '/tmp/alphred-worktree',
      },
    });

    expect(result.executedNodes).toBe(1);
    expect(result.finalStep).toEqual({
      outcome: 'run_terminal',
      workflowRunId: runId,
      runStatus: 'failed',
    });
    expect(resolveProvider).not.toHaveBeenCalled();

    const persistedRun = db
      .select({
        status: workflowRuns.status,
        completedAt: workflowRuns.completedAt,
      })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .get();

    expect(persistedRun).toBeDefined();
    if (!persistedRun) {
      throw new Error('Expected persisted workflow run row.');
    }

    expect(persistedRun.status).toBe('failed');
    expect(persistedRun.completedAt).not.toBeNull();

    const persistedRunNode = db
      .select({
        status: runNodes.status,
        completedAt: runNodes.completedAt,
      })
      .from(runNodes)
      .where(eq(runNodes.id, runNodeId))
      .get();

    expect(persistedRunNode).toBeDefined();
    if (!persistedRunNode) {
      throw new Error('Expected persisted run-node row.');
    }

    expect(persistedRunNode.status).toBe('failed');
    expect(persistedRunNode.completedAt).not.toBeNull();

    const artifacts = db
      .select({
        artifactType: phaseArtifacts.artifactType,
        contentType: phaseArtifacts.contentType,
        content: phaseArtifacts.content,
      })
      .from(phaseArtifacts)
      .where(eq(phaseArtifacts.runNodeId, runNodeId))
      .all();

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].artifactType).toBe('log');
    expect(artifacts[0].contentType).toBe('text');
    expect(artifacts[0].content).toContain('Unsupported node type "human"');
  });
});
