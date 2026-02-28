import { and, asc, eq } from 'drizzle-orm';
import {
  createDatabase,
  materializeWorkflowRunFromTree,
  migrateDatabase,
  phaseArtifacts,
  promptTemplates,
  runJoinBarriers,
  runNodeEdges,
  treeEdges,
  treeNodes,
  workflowTrees,
} from '@alphred/db';
import { describe, expect, it } from 'vitest';
import {
  parseSpawnerSubtasks,
  releaseReadyJoinBarriersForJoinNode,
  reopenJoinBarrierForRetriedChild,
  spawnDynamicChildrenForSpawner,
  updateJoinBarrierForChildTerminal,
} from './fanout.js';
import { loadEdgeRows, loadRunNodeExecutionRows } from './persistence.js';
import { loadLatestArtifactsByRunNodeId, loadLatestRoutingDecisionsByRunNodeId } from './routing-selection.js';
import { buildRoutingSelection } from './routing-selection.js';
import type { RunNodeExecutionRow } from './types.js';

function seedSpawnerJoinRun(
  params: {
    staticSuccessPriority?: number;
  } = {},
): {
  db: ReturnType<typeof createDatabase>;
  runId: number;
  spawnerNode: RunNodeExecutionRow;
  joinNode: RunNodeExecutionRow;
} {
  const db = createDatabase(':memory:');
  migrateDatabase(db);

  const tree = db
    .insert(workflowTrees)
    .values({
      treeKey: 'fanout_barrier_guard_tree',
      version: 1,
      name: 'Fanout Barrier Guard Tree',
    })
    .returning({ id: workflowTrees.id })
    .get();

  const spawnerPrompt = db
    .insert(promptTemplates)
    .values({
      templateKey: 'fanout_barrier_guard_spawner_prompt',
      version: 1,
      content: 'Break down work into subtasks.',
      contentType: 'markdown',
    })
    .returning({ id: promptTemplates.id })
    .get();

  const joinPrompt = db
    .insert(promptTemplates)
    .values({
      templateKey: 'fanout_barrier_guard_join_prompt',
      version: 1,
      content: 'Aggregate child outputs.',
      contentType: 'markdown',
    })
    .returning({ id: promptTemplates.id })
    .get();

  const insertedNodes = db
    .insert(treeNodes)
    .values([
      {
        workflowTreeId: tree.id,
        nodeKey: 'breakdown',
        nodeRole: 'spawner',
        nodeType: 'agent',
        provider: 'codex',
        promptTemplateId: spawnerPrompt.id,
        sequenceIndex: 10,
        maxChildren: 8,
      },
      {
        workflowTreeId: tree.id,
        nodeKey: 'final-review',
        nodeRole: 'join',
        nodeType: 'agent',
        provider: 'codex',
        promptTemplateId: joinPrompt.id,
        sequenceIndex: 20,
      },
    ])
    .returning({
      id: treeNodes.id,
      nodeKey: treeNodes.nodeKey,
    })
    .all();

  const nodeIdByKey = new Map(insertedNodes.map(node => [node.nodeKey, node.id]));
  const spawnerNodeId = nodeIdByKey.get('breakdown');
  const joinNodeId = nodeIdByKey.get('final-review');
  if (!spawnerNodeId || !joinNodeId) {
    throw new Error('Expected spawner and join tree nodes to exist.');
  }

  db.insert(treeEdges)
    .values({
      workflowTreeId: tree.id,
      sourceNodeId: spawnerNodeId,
      targetNodeId: joinNodeId,
      routeOn: 'success',
      priority: params.staticSuccessPriority ?? 0,
      auto: 1,
    })
    .run();

  const materialized = materializeWorkflowRunFromTree(db, {
    treeKey: 'fanout_barrier_guard_tree',
  });
  const runNodes = loadRunNodeExecutionRows(db, materialized.run.id);
  const spawnerNode = runNodes.find(node => node.nodeKey === 'breakdown');
  const joinNode = runNodes.find(node => node.nodeKey === 'final-review');
  if (!spawnerNode || !joinNode) {
    throw new Error('Expected spawner and join run nodes to be materialized.');
  }

  return {
    db,
    runId: materialized.run.id,
    spawnerNode,
    joinNode,
  };
}

function insertSpawnerReportArtifact(params: {
  db: ReturnType<typeof createDatabase>;
  runId: number;
  spawnerRunNodeId: number;
  content: string;
}): number {
  const artifact = params.db
    .insert(phaseArtifacts)
    .values({
      workflowRunId: params.runId,
      runNodeId: params.spawnerRunNodeId,
      artifactType: 'report',
      contentType: 'json',
      content: params.content,
      metadata: null,
    })
    .returning({ id: phaseArtifacts.id })
    .get();

  return artifact.id;
}

describe('fanout join barrier guards', () => {
  it('keeps the static spawner->join route selected after dynamic child edges are inserted', () => {
    const { db, runId, spawnerNode, joinNode } = seedSpawnerJoinRun({
      staticSuccessPriority: 100,
    });
    const spawnArtifactId = insertSpawnerReportArtifact({
      db,
      runId,
      spawnerRunNodeId: spawnerNode.runNodeId,
      content: 'spawn-priority-check',
    });

    spawnDynamicChildrenForSpawner(db, {
      workflowRunId: runId,
      spawnerNode,
      joinNode,
      spawnSourceArtifactId: spawnArtifactId,
      subtasks: [
        {
          nodeKey: 'priority-child-a',
          title: 'Priority Child A',
          prompt: 'Implement A',
          provider: null,
          model: null,
          metadata: null,
        },
        {
          nodeKey: 'priority-child-b',
          title: 'Priority Child B',
          prompt: 'Implement B',
          provider: null,
          model: null,
          metadata: null,
        },
      ],
    });

    const edgeRows = loadEdgeRows(db, runId);
    const staticJoinEdge = edgeRows.find(
      edge =>
        edge.sourceNodeId === spawnerNode.runNodeId &&
        edge.targetNodeId === joinNode.runNodeId &&
        edge.routeOn === 'success' &&
        edge.edgeKind === 'tree',
    );
    expect(staticJoinEdge?.priority).toBe(100);

    const dynamicSpawnerEdges = edgeRows
      .filter(
        edge =>
          edge.sourceNodeId === spawnerNode.runNodeId &&
          edge.routeOn === 'success' &&
          edge.edgeKind === 'dynamic_spawner_to_child',
      )
      .sort((left, right) => left.priority - right.priority);
    expect(dynamicSpawnerEdges.map(edge => edge.priority)).toEqual([101, 102]);

    const latestNodeAttempts = loadRunNodeExecutionRows(db, runId).map(node =>
      node.runNodeId === spawnerNode.runNodeId
        ? {
            ...node,
            status: 'completed' as const,
          }
        : node,
    );
    const routingSelection = buildRoutingSelection(
      latestNodeAttempts,
      edgeRows,
      loadLatestRoutingDecisionsByRunNodeId(db, runId).latestByRunNodeId,
      loadLatestArtifactsByRunNodeId(db, runId),
    );

    expect(routingSelection.selectedEdgeIdBySourceNodeId.get(spawnerNode.runNodeId)).toBe(staticJoinEdge?.edgeId);
  });

  it('rejects a second active barrier for the same spawner and join', () => {
    const { db, runId, spawnerNode, joinNode } = seedSpawnerJoinRun();
    const firstArtifactId = insertSpawnerReportArtifact({
      db,
      runId,
      spawnerRunNodeId: spawnerNode.runNodeId,
      content: 'first-spawn',
    });

    spawnDynamicChildrenForSpawner(db, {
      workflowRunId: runId,
      spawnerNode,
      joinNode,
      spawnSourceArtifactId: firstArtifactId,
      subtasks: [
        {
          nodeKey: 'child-a',
          title: 'Child A',
          prompt: 'Implement child A',
          provider: null,
          model: null,
          metadata: null,
        },
      ],
    });

    const secondArtifactId = insertSpawnerReportArtifact({
      db,
      runId,
      spawnerRunNodeId: spawnerNode.runNodeId,
      content: 'second-spawn',
    });

    expect(() =>
      spawnDynamicChildrenForSpawner(db, {
        workflowRunId: runId,
        spawnerNode,
        joinNode,
        spawnSourceArtifactId: secondArtifactId,
        subtasks: [
          {
            nodeKey: 'child-b',
            title: 'Child B',
            prompt: 'Implement child B',
            provider: null,
            model: null,
            metadata: null,
          },
        ],
      }),
    ).toThrow('cannot emit another fan-out batch');
  });

  it('rolls back child inserts when barrier creation fails on duplicate spawn source artifact id', () => {
    const { db, runId, spawnerNode, joinNode } = seedSpawnerJoinRun();
    const spawnArtifactId = insertSpawnerReportArtifact({
      db,
      runId,
      spawnerRunNodeId: spawnerNode.runNodeId,
      content: 'spawn-seed',
    });

    spawnDynamicChildrenForSpawner(db, {
      workflowRunId: runId,
      spawnerNode,
      joinNode,
      spawnSourceArtifactId: spawnArtifactId,
      subtasks: [
        {
          nodeKey: 'child-a',
          title: 'Child A',
          prompt: 'Implement child A',
          provider: null,
          model: null,
          metadata: null,
        },
      ],
    });

    const firstChild = loadRunNodeExecutionRows(db, runId).find(node => node.nodeKey === 'child-a');
    if (!firstChild) {
      throw new Error('Expected first dynamic child run node to be created.');
    }

    updateJoinBarrierForChildTerminal(db, {
      workflowRunId: runId,
      childNode: firstChild,
      childTerminalStatus: 'completed',
    });
    releaseReadyJoinBarriersForJoinNode(db, {
      workflowRunId: runId,
      joinRunNodeId: joinNode.runNodeId,
    });

    expect(() =>
      db.transaction((tx) => {
        const transactionalDb = tx as unknown as Parameters<typeof spawnDynamicChildrenForSpawner>[0];
        spawnDynamicChildrenForSpawner(transactionalDb, {
          workflowRunId: runId,
          spawnerNode,
          joinNode,
          spawnSourceArtifactId: spawnArtifactId,
          subtasks: [
            {
              nodeKey: 'child-b',
              title: 'Child B',
              prompt: 'Implement child B',
              provider: null,
              model: null,
              metadata: null,
            },
          ],
        });
      }),
    ).toThrow(/UNIQUE constraint failed|run_join_barriers_spawn_uq/);

    const childrenAfterDuplicateSpawn = loadRunNodeExecutionRows(db, runId).filter(
      node => node.spawnerNodeId === spawnerNode.runNodeId && node.joinNodeId === joinNode.runNodeId,
    );
    expect(childrenAfterDuplicateSpawn.map(node => node.nodeKey)).toEqual(['child-a']);

    const dynamicEdgesAfterDuplicateSpawn = loadEdgeRows(db, runId).filter(
      edge => edge.edgeKind === 'dynamic_spawner_to_child' || edge.edgeKind === 'dynamic_child_to_join',
    );
    expect(dynamicEdgesAfterDuplicateSpawn).toHaveLength(2);

    const barriers = db
      .select({
        spawnSourceArtifactId: runJoinBarriers.spawnSourceArtifactId,
        expectedChildren: runJoinBarriers.expectedChildren,
        terminalChildren: runJoinBarriers.terminalChildren,
        completedChildren: runJoinBarriers.completedChildren,
        failedChildren: runJoinBarriers.failedChildren,
        status: runJoinBarriers.status,
      })
      .from(runJoinBarriers)
      .where(eq(runJoinBarriers.workflowRunId, runId))
      .orderBy(asc(runJoinBarriers.id))
      .all();

    expect(barriers).toEqual([
      {
        spawnSourceArtifactId: spawnArtifactId,
        expectedChildren: 1,
        terminalChildren: 1,
        completedChildren: 1,
        failedChildren: 0,
        status: 'released',
      },
    ]);
  });

  it('fails fast when a retried child cannot be mapped to a barrier because the dynamic edge is missing', () => {
    const { db, runId, spawnerNode, joinNode } = seedSpawnerJoinRun();
    const firstArtifactId = insertSpawnerReportArtifact({
      db,
      runId,
      spawnerRunNodeId: spawnerNode.runNodeId,
      content: 'spawn-a',
    });
    const secondArtifactId = insertSpawnerReportArtifact({
      db,
      runId,
      spawnerRunNodeId: spawnerNode.runNodeId,
      content: 'spawn-b',
    });

    spawnDynamicChildrenForSpawner(db, {
      workflowRunId: runId,
      spawnerNode,
      joinNode,
      spawnSourceArtifactId: firstArtifactId,
      subtasks: [
        {
          nodeKey: 'first-child',
          title: 'First Child',
          prompt: 'Implement first child',
          provider: null,
          model: null,
          metadata: null,
        },
      ],
    });

    const firstChild = loadRunNodeExecutionRows(db, runId).find(node => node.nodeKey === 'first-child');
    if (!firstChild) {
      throw new Error('Expected first dynamic child run node to be created.');
    }

    updateJoinBarrierForChildTerminal(db, {
      workflowRunId: runId,
      childNode: firstChild,
      childTerminalStatus: 'completed',
    });
    releaseReadyJoinBarriersForJoinNode(db, {
      workflowRunId: runId,
      joinRunNodeId: joinNode.runNodeId,
    });

    spawnDynamicChildrenForSpawner(db, {
      workflowRunId: runId,
      spawnerNode,
      joinNode,
      spawnSourceArtifactId: secondArtifactId,
      subtasks: [
        {
          nodeKey: 'second-child',
          title: 'Second Child',
          prompt: 'Implement second child',
          provider: null,
          model: null,
          metadata: null,
        },
      ],
    });

    db.delete(runNodeEdges)
      .where(
        and(
          eq(runNodeEdges.workflowRunId, runId),
          eq(runNodeEdges.sourceRunNodeId, spawnerNode.runNodeId),
          eq(runNodeEdges.targetRunNodeId, firstChild.runNodeId),
          eq(runNodeEdges.routeOn, 'success'),
          eq(runNodeEdges.edgeKind, 'dynamic_spawner_to_child'),
        ),
      )
      .run();

    expect(() =>
      reopenJoinBarrierForRetriedChild(db, {
        workflowRunId: runId,
        childNode: firstChild,
        previousTerminalStatus: 'completed',
      }),
    ).toThrow('cannot map child runNodeId');
  });

  it('ignores stale terminal updates after the barrier is already satisfied', () => {
    const { db, runId, spawnerNode, joinNode } = seedSpawnerJoinRun();
    const artifactId = insertSpawnerReportArtifact({
      db,
      runId,
      spawnerRunNodeId: spawnerNode.runNodeId,
      content: 'spawn-a',
    });

    spawnDynamicChildrenForSpawner(db, {
      workflowRunId: runId,
      spawnerNode,
      joinNode,
      spawnSourceArtifactId: artifactId,
      subtasks: [
        {
          nodeKey: 'child-a',
          title: 'Child A',
          prompt: 'Implement child A',
          provider: null,
          model: null,
          metadata: null,
        },
      ],
    });

    const childNode = loadRunNodeExecutionRows(db, runId).find(node => node.nodeKey === 'child-a');
    if (!childNode) {
      throw new Error('Expected dynamic child run node to be created.');
    }

    updateJoinBarrierForChildTerminal(db, {
      workflowRunId: runId,
      childNode,
      childTerminalStatus: 'completed',
    });

    const barrierAfterFirstTerminal = db
      .select({
        terminalChildren: runJoinBarriers.terminalChildren,
        completedChildren: runJoinBarriers.completedChildren,
        failedChildren: runJoinBarriers.failedChildren,
        status: runJoinBarriers.status,
      })
      .from(runJoinBarriers)
      .where(eq(runJoinBarriers.workflowRunId, runId))
      .get();

    expect(barrierAfterFirstTerminal).toEqual({
      terminalChildren: 1,
      completedChildren: 1,
      failedChildren: 0,
      status: 'ready',
    });

    updateJoinBarrierForChildTerminal(db, {
      workflowRunId: runId,
      childNode,
      childTerminalStatus: 'failed',
    });

    const barrierAfterStaleTerminal = db
      .select({
        terminalChildren: runJoinBarriers.terminalChildren,
        completedChildren: runJoinBarriers.completedChildren,
        failedChildren: runJoinBarriers.failedChildren,
        status: runJoinBarriers.status,
      })
      .from(runJoinBarriers)
      .where(eq(runJoinBarriers.workflowRunId, runId))
      .get();

    expect(barrierAfterStaleTerminal).toEqual(barrierAfterFirstTerminal);
  });

  it('generates batch-scoped default node keys so repeated spawner batches do not collide', () => {
    const { db, runId, spawnerNode, joinNode } = seedSpawnerJoinRun();
    const firstArtifactId = insertSpawnerReportArtifact({
      db,
      runId,
      spawnerRunNodeId: spawnerNode.runNodeId,
      content: 'first-spawn',
    });
    const secondArtifactId = insertSpawnerReportArtifact({
      db,
      runId,
      spawnerRunNodeId: spawnerNode.runNodeId,
      content: 'second-spawn',
    });
    const spawnerReport = JSON.stringify({
      schemaVersion: 1,
      subtasks: [
        {
          title: 'Child A',
          prompt: 'Implement child A',
        },
        {
          title: 'Child B',
          prompt: 'Implement child B',
        },
      ],
    });

    const firstBatchSubtasks = parseSpawnerSubtasks({
      report: spawnerReport,
      spawnerNodeKey: spawnerNode.nodeKey,
      maxChildren: spawnerNode.maxChildren,
      lineageDepth: spawnerNode.lineageDepth,
      batchOrdinal: 1,
    });
    expect(firstBatchSubtasks.map(subtask => subtask.nodeKey)).toEqual(['breakdown__1__1', 'breakdown__1__2']);

    spawnDynamicChildrenForSpawner(db, {
      workflowRunId: runId,
      spawnerNode,
      joinNode,
      spawnSourceArtifactId: firstArtifactId,
      subtasks: firstBatchSubtasks,
    });

    const firstBatchChildren = loadRunNodeExecutionRows(db, runId).filter(
      node => node.spawnerNodeId === spawnerNode.runNodeId && node.joinNodeId === joinNode.runNodeId,
    );
    expect(firstBatchChildren.map(node => node.nodeKey)).toEqual(['breakdown__1__1', 'breakdown__1__2']);

    for (const childNode of firstBatchChildren) {
      updateJoinBarrierForChildTerminal(db, {
        workflowRunId: runId,
        childNode,
        childTerminalStatus: 'completed',
      });
    }
    releaseReadyJoinBarriersForJoinNode(db, {
      workflowRunId: runId,
      joinRunNodeId: joinNode.runNodeId,
    });

    const secondBatchSubtasks = parseSpawnerSubtasks({
      report: spawnerReport,
      spawnerNodeKey: spawnerNode.nodeKey,
      maxChildren: spawnerNode.maxChildren,
      lineageDepth: spawnerNode.lineageDepth,
      batchOrdinal: 2,
    });
    expect(secondBatchSubtasks.map(subtask => subtask.nodeKey)).toEqual(['breakdown__2__1', 'breakdown__2__2']);

    expect(() =>
      spawnDynamicChildrenForSpawner(db, {
        workflowRunId: runId,
        spawnerNode,
        joinNode,
        spawnSourceArtifactId: secondArtifactId,
        subtasks: secondBatchSubtasks,
      }),
    ).not.toThrow();

    const allChildren = loadRunNodeExecutionRows(db, runId).filter(
      node => node.spawnerNodeId === spawnerNode.runNodeId && node.joinNodeId === joinNode.runNodeId,
    );
    expect(allChildren.map(node => node.nodeKey)).toEqual([
      'breakdown__1__1',
      'breakdown__1__2',
      'breakdown__2__1',
      'breakdown__2__2',
    ]);
  });

  it('reopens the retried child barrier without mutating newer barriers', () => {
    const { db, runId, spawnerNode, joinNode } = seedSpawnerJoinRun();
    const firstArtifactId = insertSpawnerReportArtifact({
      db,
      runId,
      spawnerRunNodeId: spawnerNode.runNodeId,
      content: 'spawn-a',
    });
    const secondArtifactId = insertSpawnerReportArtifact({
      db,
      runId,
      spawnerRunNodeId: spawnerNode.runNodeId,
      content: 'spawn-b',
    });

    spawnDynamicChildrenForSpawner(db, {
      workflowRunId: runId,
      spawnerNode,
      joinNode,
      spawnSourceArtifactId: firstArtifactId,
      subtasks: [
        {
          nodeKey: 'first-child',
          title: 'First Child',
          prompt: 'Implement first child',
          provider: null,
          model: null,
          metadata: null,
        },
      ],
    });

    const firstChild = loadRunNodeExecutionRows(db, runId).find(node => node.nodeKey === 'first-child');
    if (!firstChild) {
      throw new Error('Expected first dynamic child run node to be created.');
    }

    updateJoinBarrierForChildTerminal(db, {
      workflowRunId: runId,
      childNode: firstChild,
      childTerminalStatus: 'failed',
    });
    releaseReadyJoinBarriersForJoinNode(db, {
      workflowRunId: runId,
      joinRunNodeId: joinNode.runNodeId,
    });

    spawnDynamicChildrenForSpawner(db, {
      workflowRunId: runId,
      spawnerNode,
      joinNode,
      spawnSourceArtifactId: secondArtifactId,
      subtasks: [
        {
          nodeKey: 'second-child',
          title: 'Second Child',
          prompt: 'Implement second child',
          provider: null,
          model: null,
          metadata: null,
        },
      ],
    });

    const secondChild = loadRunNodeExecutionRows(db, runId).find(node => node.nodeKey === 'second-child');
    if (!secondChild) {
      throw new Error('Expected second dynamic child run node to be created.');
    }

    updateJoinBarrierForChildTerminal(db, {
      workflowRunId: runId,
      childNode: secondChild,
      childTerminalStatus: 'completed',
    });
    reopenJoinBarrierForRetriedChild(db, {
      workflowRunId: runId,
      childNode: firstChild,
      previousTerminalStatus: 'failed',
    });
    updateJoinBarrierForChildTerminal(db, {
      workflowRunId: runId,
      childNode: firstChild,
      childTerminalStatus: 'completed',
    });

    const barriers = db
      .select({
        expectedChildren: runJoinBarriers.expectedChildren,
        terminalChildren: runJoinBarriers.terminalChildren,
        completedChildren: runJoinBarriers.completedChildren,
        failedChildren: runJoinBarriers.failedChildren,
        status: runJoinBarriers.status,
      })
      .from(runJoinBarriers)
      .where(eq(runJoinBarriers.workflowRunId, runId))
      .orderBy(asc(runJoinBarriers.id))
      .all();

    expect(barriers).toEqual([
      {
        expectedChildren: 1,
        terminalChildren: 1,
        completedChildren: 1,
        failedChildren: 0,
        status: 'ready',
      },
      {
        expectedChildren: 1,
        terminalChildren: 1,
        completedChildren: 1,
        failedChildren: 0,
        status: 'ready',
      },
    ]);
  });

  it('reopens a ready barrier when a failed child is retried', () => {
    const { db, runId, spawnerNode, joinNode } = seedSpawnerJoinRun();
    const artifactId = insertSpawnerReportArtifact({
      db,
      runId,
      spawnerRunNodeId: spawnerNode.runNodeId,
      content: 'spawn-a',
    });

    spawnDynamicChildrenForSpawner(db, {
      workflowRunId: runId,
      spawnerNode,
      joinNode,
      spawnSourceArtifactId: artifactId,
      subtasks: [
        {
          nodeKey: 'child-a',
          title: 'Child A',
          prompt: 'Implement child A',
          provider: null,
          model: null,
          metadata: null,
        },
      ],
    });

    const childNode = loadRunNodeExecutionRows(db, runId).find(node => node.nodeKey === 'child-a');
    if (!childNode) {
      throw new Error('Expected dynamic child run node to be created.');
    }

    updateJoinBarrierForChildTerminal(db, {
      workflowRunId: runId,
      childNode,
      childTerminalStatus: 'failed',
    });

    reopenJoinBarrierForRetriedChild(db, {
      workflowRunId: runId,
      childNode,
      previousTerminalStatus: 'failed',
    });

    const reopenedBarrier = db
      .select({
        terminalChildren: runJoinBarriers.terminalChildren,
        completedChildren: runJoinBarriers.completedChildren,
        failedChildren: runJoinBarriers.failedChildren,
        status: runJoinBarriers.status,
      })
      .from(runJoinBarriers)
      .where(eq(runJoinBarriers.workflowRunId, runId))
      .get();

    expect(reopenedBarrier).toEqual({
      terminalChildren: 0,
      completedChildren: 0,
      failedChildren: 0,
      status: 'pending',
    });

    updateJoinBarrierForChildTerminal(db, {
      workflowRunId: runId,
      childNode,
      childTerminalStatus: 'completed',
    });

    const completedBarrier = db
      .select({
        terminalChildren: runJoinBarriers.terminalChildren,
        completedChildren: runJoinBarriers.completedChildren,
        failedChildren: runJoinBarriers.failedChildren,
        status: runJoinBarriers.status,
      })
      .from(runJoinBarriers)
      .where(eq(runJoinBarriers.workflowRunId, runId))
      .get();

    expect(completedBarrier).toEqual({
      terminalChildren: 1,
      completedChildren: 1,
      failedChildren: 0,
      status: 'ready',
    });
  });

  it('reopens a released barrier when a failed child is retried', () => {
    const { db, runId, spawnerNode, joinNode } = seedSpawnerJoinRun();
    const artifactId = insertSpawnerReportArtifact({
      db,
      runId,
      spawnerRunNodeId: spawnerNode.runNodeId,
      content: 'spawn-a',
    });

    spawnDynamicChildrenForSpawner(db, {
      workflowRunId: runId,
      spawnerNode,
      joinNode,
      spawnSourceArtifactId: artifactId,
      subtasks: [
        {
          nodeKey: 'child-a',
          title: 'Child A',
          prompt: 'Implement child A',
          provider: null,
          model: null,
          metadata: null,
        },
      ],
    });

    const childNode = loadRunNodeExecutionRows(db, runId).find(node => node.nodeKey === 'child-a');
    if (!childNode) {
      throw new Error('Expected dynamic child run node to be created.');
    }

    updateJoinBarrierForChildTerminal(db, {
      workflowRunId: runId,
      childNode,
      childTerminalStatus: 'failed',
    });
    releaseReadyJoinBarriersForJoinNode(db, {
      workflowRunId: runId,
      joinRunNodeId: joinNode.runNodeId,
    });

    reopenJoinBarrierForRetriedChild(db, {
      workflowRunId: runId,
      childNode,
      previousTerminalStatus: 'failed',
    });

    const reopenedBarrier = db
      .select({
        terminalChildren: runJoinBarriers.terminalChildren,
        completedChildren: runJoinBarriers.completedChildren,
        failedChildren: runJoinBarriers.failedChildren,
        status: runJoinBarriers.status,
      })
      .from(runJoinBarriers)
      .where(eq(runJoinBarriers.workflowRunId, runId))
      .get();

    expect(reopenedBarrier).toEqual({
      terminalChildren: 0,
      completedChildren: 0,
      failedChildren: 0,
      status: 'pending',
    });

    updateJoinBarrierForChildTerminal(db, {
      workflowRunId: runId,
      childNode,
      childTerminalStatus: 'completed',
    });

    const completedBarrier = db
      .select({
        terminalChildren: runJoinBarriers.terminalChildren,
        completedChildren: runJoinBarriers.completedChildren,
        failedChildren: runJoinBarriers.failedChildren,
        status: runJoinBarriers.status,
      })
      .from(runJoinBarriers)
      .where(eq(runJoinBarriers.workflowRunId, runId))
      .get();

    expect(completedBarrier).toEqual({
      terminalChildren: 1,
      completedChildren: 1,
      failedChildren: 0,
      status: 'ready',
    });
  });
});
