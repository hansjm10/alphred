import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  createDatabase,
  materializeWorkflowRunFromTree,
  migrateDatabase,
  phaseArtifacts,
  promptTemplates,
  runNodes,
  transitionRunNodeStatus,
  transitionWorkflowRunStatus,
  treeEdges,
  treeNodes,
  workflowTrees,
  type AlphredDatabase,
} from '@alphred/db';
import { ERROR_HANDLER_SUMMARY_METADATA_KIND } from './constants.js';
import { assembleUpstreamArtifactContext } from './context-assembly.js';
import { releaseReadyJoinBarriersForJoinNode, spawnDynamicChildrenForSpawner, updateJoinBarrierForChildTerminal } from './fanout.js';
import { loadEdgeRows, loadRunNodeExecutionRows } from './persistence.js';
import { loadLatestArtifactsByRunNodeId, loadLatestRoutingDecisionsByRunNodeId } from './routing-selection.js';
import { transitionCompletedRunNodeToPendingAttempt, transitionFailedRunNodeToRetryAttempt } from './transitions.js';
import { getLatestRunNodeAttempts } from './type-conversions.js';

type SeededRun = {
  db: AlphredDatabase;
  runId: number;
  treeId: number;
  runNodeIdByKey: Map<string, number>;
};

function createRunNodeIdMap(db: AlphredDatabase, runId: number): Map<string, number> {
  const rows = db
    .select({
      id: runNodes.id,
      nodeKey: runNodes.nodeKey,
    })
    .from(runNodes)
    .where(eq(runNodes.workflowRunId, runId))
    .all();
  return new Map(rows.map(row => [row.nodeKey, row.id]));
}

function assembleContextForTarget(params: {
  db: AlphredDatabase;
  runId: number;
  treeId: number;
  targetRunNodeId: number;
}) {
  const latestNodeAttempts = getLatestRunNodeAttempts(loadRunNodeExecutionRows(params.db, params.runId));
  const targetNode = latestNodeAttempts.find(node => node.runNodeId === params.targetRunNodeId);
  if (!targetNode) {
    throw new Error(`Expected target run-node id=${params.targetRunNodeId} to exist.`);
  }

  return assembleUpstreamArtifactContext(params.db, {
    workflowRunId: params.runId,
    targetNode,
    targetAttempt: targetNode.attempt,
    latestNodeAttempts,
    edgeRows: loadEdgeRows(params.db, params.treeId),
    latestRoutingDecisionsByRunNodeId: loadLatestRoutingDecisionsByRunNodeId(params.db, params.runId).latestByRunNodeId,
    latestArtifactsByRunNodeId: loadLatestArtifactsByRunNodeId(params.db, params.runId),
  });
}

function seedMixedSuccessAndFailureSourcesRun(): SeededRun {
  const db = createDatabase(':memory:');
  migrateDatabase(db);

  const tree = db
    .insert(workflowTrees)
    .values({
      treeKey: 'context_assembly_mixed_sources_tree',
      version: 1,
      name: 'Context Assembly Mixed Sources Tree',
    })
    .returning({ id: workflowTrees.id })
    .get();
  const prompt = db
    .insert(promptTemplates)
    .values({
      templateKey: 'context_assembly_mixed_sources_prompt',
      version: 1,
      content: 'Generate output',
      contentType: 'markdown',
    })
    .returning({ id: promptTemplates.id })
    .get();

  const sourceSuccessNode = db
    .insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'source_success',
      nodeType: 'agent',
      provider: 'codex',
      promptTemplateId: prompt.id,
      sequenceIndex: 10,
    })
    .returning({ id: treeNodes.id })
    .get();
  const sourceFailureNode = db
    .insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'source_failure',
      nodeType: 'agent',
      provider: 'codex',
      promptTemplateId: prompt.id,
      sequenceIndex: 20,
    })
    .returning({ id: treeNodes.id })
    .get();
  const targetNode = db
    .insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'target',
      nodeType: 'agent',
      provider: 'codex',
      promptTemplateId: prompt.id,
      sequenceIndex: 30,
    })
    .returning({ id: treeNodes.id })
    .get();

  db.insert(treeEdges)
    .values([
      {
        workflowTreeId: tree.id,
        sourceNodeId: sourceSuccessNode.id,
        targetNodeId: targetNode.id,
        routeOn: 'success',
        priority: 0,
        auto: 1,
      },
      {
        workflowTreeId: tree.id,
        sourceNodeId: sourceFailureNode.id,
        targetNodeId: targetNode.id,
        routeOn: 'failure',
        priority: 0,
        auto: 1,
      },
    ])
    .run();

  const materialized = materializeWorkflowRunFromTree(db, { treeKey: 'context_assembly_mixed_sources_tree' });
  return {
    db,
    runId: materialized.run.id,
    treeId: tree.id,
    runNodeIdByKey: createRunNodeIdMap(db, materialized.run.id),
  };
}

function seedFailureRouteRun(): SeededRun {
  const db = createDatabase(':memory:');
  migrateDatabase(db);

  const tree = db
    .insert(workflowTrees)
    .values({
      treeKey: 'context_assembly_failure_route_tree',
      version: 1,
      name: 'Context Assembly Failure Route Tree',
    })
    .returning({ id: workflowTrees.id })
    .get();
  const prompt = db
    .insert(promptTemplates)
    .values({
      templateKey: 'context_assembly_failure_route_prompt',
      version: 1,
      content: 'Remediate failure',
      contentType: 'markdown',
    })
    .returning({ id: promptTemplates.id })
    .get();

  const sourceNode = db
    .insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'source',
      nodeType: 'agent',
      provider: 'codex',
      promptTemplateId: prompt.id,
      maxRetries: 2,
      sequenceIndex: 10,
    })
    .returning({ id: treeNodes.id })
    .get();
  const targetNode = db
    .insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'target',
      nodeType: 'agent',
      provider: 'codex',
      promptTemplateId: prompt.id,
      sequenceIndex: 20,
    })
    .returning({ id: treeNodes.id })
    .get();

  db.insert(treeEdges)
    .values({
      workflowTreeId: tree.id,
      sourceNodeId: sourceNode.id,
      targetNodeId: targetNode.id,
      routeOn: 'failure',
      priority: 0,
      auto: 1,
    })
    .run();

  const materialized = materializeWorkflowRunFromTree(db, { treeKey: 'context_assembly_failure_route_tree' });
  return {
    db,
    runId: materialized.run.id,
    treeId: tree.id,
    runNodeIdByKey: createRunNodeIdMap(db, materialized.run.id),
  };
}

function seedJoinFanoutContextRun(): SeededRun {
  const db = createDatabase(':memory:');
  migrateDatabase(db);

  const tree = db
    .insert(workflowTrees)
    .values({
      treeKey: 'context_assembly_join_fanout_tree',
      version: 1,
      name: 'Context Assembly Join Fanout Tree',
    })
    .returning({ id: workflowTrees.id })
    .get();
  const prompt = db
    .insert(promptTemplates)
    .values({
      templateKey: 'context_assembly_join_fanout_prompt',
      version: 1,
      content: 'Process subtasks',
      contentType: 'markdown',
    })
    .returning({ id: promptTemplates.id })
    .get();

  const spawnerNode = db
    .insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'breakdown',
      nodeRole: 'spawner',
      nodeType: 'agent',
      provider: 'codex',
      promptTemplateId: prompt.id,
      maxChildren: 8,
      sequenceIndex: 10,
    })
    .returning({ id: treeNodes.id })
    .get();
  const joinNode = db
    .insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'aggregate',
      nodeRole: 'join',
      nodeType: 'agent',
      provider: 'codex',
      promptTemplateId: prompt.id,
      sequenceIndex: 20,
    })
    .returning({ id: treeNodes.id })
    .get();

  db.insert(treeEdges)
    .values({
      workflowTreeId: tree.id,
      sourceNodeId: spawnerNode.id,
      targetNodeId: joinNode.id,
      routeOn: 'success',
      priority: 100,
      auto: 1,
    })
    .run();

  const materialized = materializeWorkflowRunFromTree(db, { treeKey: 'context_assembly_join_fanout_tree' });
  return {
    db,
    runId: materialized.run.id,
    treeId: tree.id,
    runNodeIdByKey: createRunNodeIdMap(db, materialized.run.id),
  };
}

function insertReportArtifact(params: {
  db: AlphredDatabase;
  runId: number;
  runNodeId: number;
  content: string;
}): number {
  const artifact = params.db
    .insert(phaseArtifacts)
    .values({
      workflowRunId: params.runId,
      runNodeId: params.runNodeId,
      artifactType: 'report',
      contentType: 'markdown',
      content: params.content,
      metadata: { success: true },
    })
    .returning({ id: phaseArtifacts.id })
    .get();

  return artifact.id;
}

describe('assembleUpstreamArtifactContext failure-route handling', () => {
  it('omits stale failure-route context when rerun is triggered by a fresh success artifact', () => {
    const { db, runId, treeId, runNodeIdByKey } = seedMixedSuccessAndFailureSourcesRun();
    const sourceSuccessRunNodeId = runNodeIdByKey.get('source_success');
    const sourceFailureRunNodeId = runNodeIdByKey.get('source_failure');
    const targetRunNodeId = runNodeIdByKey.get('target');
    if (!sourceSuccessRunNodeId || !sourceFailureRunNodeId || !targetRunNodeId) {
      throw new Error('Expected mixed-source run-nodes to be materialized.');
    }

    transitionWorkflowRunStatus(db, {
      workflowRunId: runId,
      expectedFrom: 'pending',
      to: 'running',
    });
    transitionRunNodeStatus(db, {
      runNodeId: sourceFailureRunNodeId,
      expectedFrom: 'pending',
      to: 'running',
    });
    transitionRunNodeStatus(db, {
      runNodeId: sourceFailureRunNodeId,
      expectedFrom: 'running',
      to: 'failed',
    });
    transitionRunNodeStatus(db, {
      runNodeId: sourceSuccessRunNodeId,
      expectedFrom: 'pending',
      to: 'running',
    });
    transitionRunNodeStatus(db, {
      runNodeId: sourceSuccessRunNodeId,
      expectedFrom: 'running',
      to: 'completed',
    });
    transitionRunNodeStatus(db, {
      runNodeId: targetRunNodeId,
      expectedFrom: 'pending',
      to: 'running',
    });
    transitionRunNodeStatus(db, {
      runNodeId: targetRunNodeId,
      expectedFrom: 'running',
      to: 'completed',
    });

    const staleFailureArtifact = db
      .insert(phaseArtifacts)
      .values({
        workflowRunId: runId,
        runNodeId: sourceFailureRunNodeId,
        artifactType: 'log',
        contentType: 'text',
        content: 'source failure attempt 1',
        metadata: {
          attempt: 1,
          failureReason: 'retry_limit_exceeded',
        },
      })
      .returning({ id: phaseArtifacts.id })
      .get();
    const priorTargetArtifact = db
      .insert(phaseArtifacts)
      .values({
        workflowRunId: runId,
        runNodeId: targetRunNodeId,
        artifactType: 'report',
        contentType: 'markdown',
        content: 'target attempt 1',
        metadata: { success: true },
      })
      .returning({ id: phaseArtifacts.id })
      .get();
    const freshSuccessArtifact = db
      .insert(phaseArtifacts)
      .values({
        workflowRunId: runId,
        runNodeId: sourceSuccessRunNodeId,
        artifactType: 'report',
        contentType: 'markdown',
        content: 'source success refresh',
        metadata: { success: true },
      })
      .returning({ id: phaseArtifacts.id })
      .get();
    expect(staleFailureArtifact.id).toBeLessThan(priorTargetArtifact.id);
    expect(freshSuccessArtifact.id).toBeGreaterThan(priorTargetArtifact.id);

    transitionCompletedRunNodeToPendingAttempt(db, {
      runNodeId: targetRunNodeId,
      currentAttempt: 1,
      nextAttempt: 2,
    });
    transitionRunNodeStatus(db, {
      runNodeId: targetRunNodeId,
      expectedFrom: 'pending',
      to: 'running',
    });

    const assembly = assembleContextForTarget({
      db,
      runId,
      treeId,
      targetRunNodeId,
    });

    expect(assembly.manifest.included_artifact_ids).toContain(freshSuccessArtifact.id);
    expect(assembly.manifest.failure_route_context_included).toBe(false);
    expect(assembly.manifest.failure_route_source_node_key).toBeNull();
    expect(assembly.manifest.failure_route_failure_artifact_id).toBeNull();
    expect(assembly.manifest.failure_route_retry_summary_artifact_id).toBeNull();
    expect(assembly.contextEntries.some(entry => entry.includes('ALPHRED_FAILURE_ROUTE_CONTEXT v1'))).toBe(false);
  });

  it('does not attach retry summaries from older failure cycles to the current failure-route context', () => {
    const { db, runId, treeId, runNodeIdByKey } = seedFailureRouteRun();
    const sourceRunNodeId = runNodeIdByKey.get('source');
    const targetRunNodeId = runNodeIdByKey.get('target');
    if (!sourceRunNodeId || !targetRunNodeId) {
      throw new Error('Expected failure-route run-nodes to be materialized.');
    }

    transitionWorkflowRunStatus(db, {
      workflowRunId: runId,
      expectedFrom: 'pending',
      to: 'running',
    });
    transitionRunNodeStatus(db, {
      runNodeId: sourceRunNodeId,
      expectedFrom: 'pending',
      to: 'running',
    });
    transitionRunNodeStatus(db, {
      runNodeId: sourceRunNodeId,
      expectedFrom: 'running',
      to: 'failed',
    });
    transitionFailedRunNodeToRetryAttempt(db, {
      runNodeId: sourceRunNodeId,
      currentAttempt: 1,
      nextAttempt: 2,
    });
    transitionRunNodeStatus(db, {
      runNodeId: sourceRunNodeId,
      expectedFrom: 'running',
      to: 'failed',
    });
    transitionFailedRunNodeToRetryAttempt(db, {
      runNodeId: sourceRunNodeId,
      currentAttempt: 2,
      nextAttempt: 3,
    });
    transitionRunNodeStatus(db, {
      runNodeId: sourceRunNodeId,
      expectedFrom: 'running',
      to: 'failed',
    });
    transitionRunNodeStatus(db, {
      runNodeId: targetRunNodeId,
      expectedFrom: 'pending',
      to: 'running',
    });
    transitionRunNodeStatus(db, {
      runNodeId: targetRunNodeId,
      expectedFrom: 'running',
      to: 'completed',
    });

    const firstFailureArtifact = db
      .insert(phaseArtifacts)
      .values({
        workflowRunId: runId,
        runNodeId: sourceRunNodeId,
        artifactType: 'log',
        contentType: 'text',
        content: 'source failure attempt 1',
        metadata: {
          attempt: 1,
          failureReason: 'retry_scheduled',
        },
      })
      .returning({ id: phaseArtifacts.id })
      .get();
    const staleRetrySummaryArtifact = db
      .insert(phaseArtifacts)
      .values({
        workflowRunId: runId,
        runNodeId: sourceRunNodeId,
        artifactType: 'note',
        contentType: 'text',
        content: 'retry guidance from attempt 1 to 2',
        metadata: {
          kind: ERROR_HANDLER_SUMMARY_METADATA_KIND,
          sourceAttempt: 1,
          targetAttempt: 2,
          failureArtifactId: firstFailureArtifact.id,
        },
      })
      .returning({ id: phaseArtifacts.id })
      .get();
    db.insert(phaseArtifacts)
      .values({
        workflowRunId: runId,
        runNodeId: sourceRunNodeId,
        artifactType: 'log',
        contentType: 'text',
        content: 'source failure attempt 2',
        metadata: {
          attempt: 2,
          failureReason: 'retry_scheduled',
        },
      })
      .run();
    const priorTargetArtifact = db
      .insert(phaseArtifacts)
      .values({
        workflowRunId: runId,
        runNodeId: targetRunNodeId,
        artifactType: 'report',
        contentType: 'markdown',
        content: 'target attempt 1',
        metadata: { success: true },
      })
      .returning({ id: phaseArtifacts.id })
      .get();
    const currentFailureArtifact = db
      .insert(phaseArtifacts)
      .values({
        workflowRunId: runId,
        runNodeId: sourceRunNodeId,
        artifactType: 'log',
        contentType: 'text',
        content: 'source failure attempt 3',
        metadata: {
          attempt: 3,
          failureReason: 'retry_limit_exceeded',
        },
      })
      .returning({ id: phaseArtifacts.id })
      .get();
    expect(currentFailureArtifact.id).toBeGreaterThan(priorTargetArtifact.id);
    expect(staleRetrySummaryArtifact.id).toBeLessThan(currentFailureArtifact.id);

    transitionCompletedRunNodeToPendingAttempt(db, {
      runNodeId: targetRunNodeId,
      currentAttempt: 1,
      nextAttempt: 2,
    });
    transitionRunNodeStatus(db, {
      runNodeId: targetRunNodeId,
      expectedFrom: 'pending',
      to: 'running',
    });

    const assembly = assembleContextForTarget({
      db,
      runId,
      treeId,
      targetRunNodeId,
    });
    const failureRouteContext = assembly.contextEntries.find(entry => entry.includes('ALPHRED_FAILURE_ROUTE_CONTEXT v1'));
    if (!failureRouteContext) {
      throw new Error('Expected failure-route context entry to be assembled.');
    }

    expect(assembly.manifest.failure_route_context_included).toBe(true);
    expect(assembly.manifest.failure_route_failure_artifact_id).toBe(currentFailureArtifact.id);
    expect(assembly.manifest.failure_route_retry_summary_artifact_id).toBeNull();
    expect(failureRouteContext).toContain('retry_summary_artifact_id: null');
    expect(failureRouteContext).not.toContain('retry_summary_artifact:');
    expect(failureRouteContext).not.toContain('source_attempt: 1');
    expect(failureRouteContext).not.toContain('target_attempt: 2');
  });
});

describe('assembleUpstreamArtifactContext join fan-out batching', () => {
  it('excludes stale terminal children from earlier released barriers when assembling join context', () => {
    const { db, runId } = seedJoinFanoutContextRun();
    const runNodeIdByKey = createRunNodeIdMap(db, runId);
    const spawnerRunNodeId = runNodeIdByKey.get('breakdown');
    const joinRunNodeId = runNodeIdByKey.get('aggregate');
    if (!spawnerRunNodeId || !joinRunNodeId) {
      throw new Error('Expected spawner/join run nodes to exist.');
    }

    const initialNodes = getLatestRunNodeAttempts(loadRunNodeExecutionRows(db, runId));
    const spawnerNode = initialNodes.find(node => node.runNodeId === spawnerRunNodeId);
    const joinNode = initialNodes.find(node => node.runNodeId === joinRunNodeId);
    if (!spawnerNode || !joinNode) {
      throw new Error('Expected spawner/join run nodes to be materialized.');
    }

    transitionWorkflowRunStatus(db, {
      workflowRunId: runId,
      expectedFrom: 'pending',
      to: 'running',
    });

    const firstSpawnArtifactId = insertReportArtifact({
      db,
      runId,
      runNodeId: spawnerRunNodeId,
      content: 'first fan-out request',
    });
    spawnDynamicChildrenForSpawner(db, {
      workflowRunId: runId,
      spawnerNode,
      joinNode,
      spawnSourceArtifactId: firstSpawnArtifactId,
      subtasks: [
        {
          nodeKey: 'old-child-a',
          title: 'Old child A',
          prompt: 'old A',
          provider: null,
          model: null,
          metadata: null,
        },
        {
          nodeKey: 'old-child-b',
          title: 'Old child B',
          prompt: 'old B',
          provider: null,
          model: null,
          metadata: null,
        },
      ],
    });

    const firstBatchChildren = getLatestRunNodeAttempts(loadRunNodeExecutionRows(db, runId)).filter(
      node => node.nodeKey === 'old-child-a' || node.nodeKey === 'old-child-b',
    );
    expect(firstBatchChildren).toHaveLength(2);

    const staleArtifactIds: number[] = [];
    for (const childNode of firstBatchChildren) {
      transitionRunNodeStatus(db, {
        runNodeId: childNode.runNodeId,
        expectedFrom: 'pending',
        to: 'running',
      });
      transitionRunNodeStatus(db, {
        runNodeId: childNode.runNodeId,
        expectedFrom: 'running',
        to: 'completed',
      });
      staleArtifactIds.push(
        insertReportArtifact({
          db,
          runId,
          runNodeId: childNode.runNodeId,
          content: `stale artifact from ${childNode.nodeKey}`,
        }),
      );
      updateJoinBarrierForChildTerminal(db, {
        workflowRunId: runId,
        childNode,
        childTerminalStatus: 'completed',
      });
    }

    releaseReadyJoinBarriersForJoinNode(db, {
      workflowRunId: runId,
      joinRunNodeId,
    });

    const secondSpawnArtifactId = insertReportArtifact({
      db,
      runId,
      runNodeId: spawnerRunNodeId,
      content: 'second fan-out request',
    });
    spawnDynamicChildrenForSpawner(db, {
      workflowRunId: runId,
      spawnerNode,
      joinNode,
      spawnSourceArtifactId: secondSpawnArtifactId,
      subtasks: [
        {
          nodeKey: 'new-child-a',
          title: 'New child A',
          prompt: 'new A',
          provider: null,
          model: null,
          metadata: null,
        },
      ],
    });

    const newChild = getLatestRunNodeAttempts(loadRunNodeExecutionRows(db, runId)).find(
      node => node.nodeKey === 'new-child-a',
    );
    if (!newChild) {
      throw new Error('Expected current-batch child to be materialized.');
    }

    transitionRunNodeStatus(db, {
      runNodeId: newChild.runNodeId,
      expectedFrom: 'pending',
      to: 'running',
    });
    transitionRunNodeStatus(db, {
      runNodeId: newChild.runNodeId,
      expectedFrom: 'running',
      to: 'completed',
    });
    const currentArtifactId = insertReportArtifact({
      db,
      runId,
      runNodeId: newChild.runNodeId,
      content: 'fresh artifact from new child',
    });
    updateJoinBarrierForChildTerminal(db, {
      workflowRunId: runId,
      childNode: newChild,
      childTerminalStatus: 'completed',
    });

    const latestNodeAttempts = getLatestRunNodeAttempts(loadRunNodeExecutionRows(db, runId));
    const latestJoinNode = latestNodeAttempts.find(node => node.runNodeId === joinRunNodeId);
    if (!latestJoinNode) {
      throw new Error('Expected join run node to exist.');
    }

    const assembly = assembleUpstreamArtifactContext(db, {
      workflowRunId: runId,
      targetNode: latestJoinNode,
      targetAttempt: latestJoinNode.attempt,
      latestNodeAttempts,
      edgeRows: loadEdgeRows(db, runId),
      latestRoutingDecisionsByRunNodeId: loadLatestRoutingDecisionsByRunNodeId(db, runId).latestByRunNodeId,
      latestArtifactsByRunNodeId: loadLatestArtifactsByRunNodeId(db, runId),
    });

    expect(assembly.manifest.included_source_node_keys).toContain('new-child-a');
    expect(assembly.manifest.included_source_node_keys).not.toContain('old-child-a');
    expect(assembly.manifest.included_source_node_keys).not.toContain('old-child-b');
    expect(assembly.manifest.included_artifact_ids).toContain(currentArtifactId);
    for (const staleArtifactId of staleArtifactIds) {
      expect(assembly.manifest.included_artifact_ids).not.toContain(staleArtifactId);
    }
    const joinedContext = assembly.contextEntries.join('\n');
    expect(joinedContext).toContain('new-child-a');
    expect(joinedContext).not.toContain('old-child-a');
    expect(joinedContext).not.toContain('old-child-b');
  });
});
