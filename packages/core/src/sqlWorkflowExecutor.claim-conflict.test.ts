import { and, eq } from 'drizzle-orm';
import type { ProviderEvent, ProviderRunOptions } from '@alphred/shared';
import { describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  injectClaimConflict: false,
  injectUnexpectedClaimError: false,
}));

vi.mock('@alphred/db', async () => {
  const actual = await vi.importActual<typeof import('@alphred/db')>('@alphred/db');

  return {
    ...actual,
    transitionRunNodeStatus: (
      db: Parameters<typeof actual.transitionRunNodeStatus>[0],
      params: Parameters<typeof actual.transitionRunNodeStatus>[1],
    ) => {
      if (mockState.injectClaimConflict && params.expectedFrom === 'pending' && params.to === 'running') {
        throw new Error(
          `Run-node transition precondition failed for id=${params.runNodeId}; expected status "${params.expectedFrom}".`,
        );
      }
      if (mockState.injectUnexpectedClaimError && params.expectedFrom === 'pending' && params.to === 'running') {
        throw new Error('unexpected claim failure');
      }

      return actual.transitionRunNodeStatus(db, params);
    },
  };
});

import {
  createDatabase,
  materializeWorkflowRunFromTree,
  migrateDatabase,
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

  const treeNode = db
    .insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'design',
      nodeType: 'agent',
      provider: 'codex',
      promptTemplateId: prompt.id,
      sequenceIndex: 1,
    })
    .returning({ id: treeNodes.id })
    .get();

  const materialized = materializeWorkflowRunFromTree(db, { treeKey: 'design_tree' });
  return {
    db,
    runId: materialized.run.id,
    treeNodeId: treeNode.id,
  };
}

describe('createSqlWorkflowExecutor claim conflicts', () => {
  it('returns blocked when pending -> running claim precondition fails', async () => {
    const { db, runId, treeNodeId } = seedSingleAgentRun();
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () =>
        createProvider([
          { type: 'system', content: 'start', timestamp: 100 },
          { type: 'result', content: 'Design report body', timestamp: 102 },
        ]),
    });

    mockState.injectClaimConflict = true;
    let result: Awaited<ReturnType<typeof executor.executeNextRunnableNode>>;
    try {
      result = await executor.executeNextRunnableNode({
        workflowRunId: runId,
        options: {
          workingDirectory: '/tmp/alphred-worktree',
        },
      });
    } finally {
      mockState.injectClaimConflict = false;
    }

    expect(result).toEqual({
      outcome: 'blocked',
      workflowRunId: runId,
      runStatus: 'running',
    });

    const persistedRunNode = db
      .select({
        status: runNodes.status,
      })
      .from(runNodes)
      .where(and(eq(runNodes.workflowRunId, runId), eq(runNodes.treeNodeId, treeNodeId)))
      .get();

    expect(persistedRunNode).toBeDefined();
    if (!persistedRunNode) {
      throw new Error('Expected persisted run-node row.');
    }

    expect(persistedRunNode.status).toBe('pending');

    const persistedRun = db
      .select({
        status: workflowRuns.status,
      })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .get();

    expect(persistedRun).toBeDefined();
    if (!persistedRun) {
      throw new Error('Expected persisted workflow run row.');
    }

    expect(persistedRun.status).toBe('running');
  });

  it('rethrows unexpected claim errors', async () => {
    const { db, runId } = seedSingleAgentRun();
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: () =>
        createProvider([
          { type: 'system', content: 'start', timestamp: 100 },
          { type: 'result', content: 'Design report body', timestamp: 102 },
        ]),
    });

    mockState.injectUnexpectedClaimError = true;
    try {
      await expect(
        executor.executeNextRunnableNode({
          workflowRunId: runId,
          options: {
            workingDirectory: '/tmp/alphred-worktree',
          },
        }),
      ).rejects.toThrow('unexpected claim failure');
    } finally {
      mockState.injectUnexpectedClaimError = false;
    }
  });
});
