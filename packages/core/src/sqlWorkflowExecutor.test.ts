import { eq } from 'drizzle-orm';
import type { ProviderEvent, ProviderRunOptions } from '@alphred/shared';
import { describe, expect, it } from 'vitest';
import {
  createDatabase,
  materializeWorkflowRunFromTree,
  migrateDatabase,
  phaseArtifacts,
  promptTemplates,
  runNodes,
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
});
