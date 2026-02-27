import { eq } from 'drizzle-orm';
import {
  createDatabase,
  materializeWorkflowRunFromTree,
  migrateDatabase,
  phaseArtifacts,
  promptTemplates,
  runJoinBarriers,
  treeEdges,
  treeNodes,
  workflowTrees,
} from '@alphred/db';
import { describe, expect, it } from 'vitest';
import { spawnDynamicChildrenForSpawner, updateJoinBarrierForChildTerminal } from './fanout.js';
import { loadRunNodeExecutionRows } from './persistence.js';
import type { RunNodeExecutionRow } from './types.js';

function seedSpawnerJoinRun(): {
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
      priority: 0,
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

  it('fails fast when child barrier updates are ambiguous across active barriers', () => {
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

    db.insert(runJoinBarriers)
      .values([
        {
          workflowRunId: runId,
          spawnerRunNodeId: spawnerNode.runNodeId,
          joinRunNodeId: joinNode.runNodeId,
          spawnSourceArtifactId: firstArtifactId,
          expectedChildren: 1,
          terminalChildren: 0,
          completedChildren: 0,
          failedChildren: 0,
          status: 'pending',
        },
        {
          workflowRunId: runId,
          spawnerRunNodeId: spawnerNode.runNodeId,
          joinRunNodeId: joinNode.runNodeId,
          spawnSourceArtifactId: secondArtifactId,
          expectedChildren: 1,
          terminalChildren: 0,
          completedChildren: 0,
          failedChildren: 0,
          status: 'pending',
        },
      ])
      .run();

    expect(() =>
      updateJoinBarrierForChildTerminal(db, {
        workflowRunId: runId,
        childNode: {
          spawnerNodeId: spawnerNode.runNodeId,
          joinNodeId: joinNode.runNodeId,
        },
        childTerminalStatus: 'failed',
      }),
    ).toThrow('multiple active barriers');

    const barriers = db
      .select({
        terminalChildren: runJoinBarriers.terminalChildren,
      })
      .from(runJoinBarriers)
      .where(eq(runJoinBarriers.workflowRunId, runId))
      .all();

    expect(barriers.map(barrier => barrier.terminalChildren)).toEqual([0, 0]);
  });
});
