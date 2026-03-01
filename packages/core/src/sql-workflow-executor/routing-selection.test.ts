import {
  createDatabase,
  materializeWorkflowRunFromTree,
  migrateDatabase,
  phaseArtifacts,
  promptTemplates,
  treeNodes,
  workflowTrees,
} from '@alphred/db';
import { describe, expect, it } from 'vitest';
import { loadRunNodeExecutionRows } from './persistence.js';
import { FAILED_COMMAND_OUTPUT_ARTIFACT_KIND } from './constants.js';
import { loadLatestArtifactsByRunNodeId, resolveApplicableRoutingDecision } from './routing-selection.js';
import type { RoutingDecisionRow, RunNodeExecutionRow } from './types.js';

function createSingleNodeRun(): {
  db: ReturnType<typeof createDatabase>;
  runId: number;
  sourceNode: RunNodeExecutionRow;
} {
  const db = createDatabase(':memory:');
  migrateDatabase(db);

  const tree = db
    .insert(workflowTrees)
    .values({
      treeKey: 'routing_selection_latest_artifact_tree',
      version: 1,
      name: 'Routing Selection Latest Artifact Tree',
    })
    .returning({ id: workflowTrees.id })
    .get();

  const prompt = db
    .insert(promptTemplates)
    .values({
      templateKey: 'routing_selection_latest_artifact_prompt',
      version: 1,
      content: 'Route according to review decision.',
      contentType: 'markdown',
    })
    .returning({ id: promptTemplates.id })
    .get();

  db.insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'source',
      nodeRole: 'standard',
      nodeType: 'agent',
      provider: 'codex',
      promptTemplateId: prompt.id,
      sequenceIndex: 10,
    })
    .run();

  const materialized = materializeWorkflowRunFromTree(db, {
    treeKey: 'routing_selection_latest_artifact_tree',
  });
  const sourceNode = loadRunNodeExecutionRows(db, materialized.run.id).find(node => node.nodeKey === 'source');
  if (!sourceNode) {
    throw new Error('Expected source run node to be materialized.');
  }

  return {
    db,
    runId: materialized.run.id,
    sourceNode,
  };
}

describe('routing selection artifact freshness', () => {
  it('ignores failed command output artifacts when selecting latest artifacts by run node', () => {
    const { db, runId, sourceNode } = createSingleNodeRun();

    const reportArtifact = db
      .insert(phaseArtifacts)
      .values({
        workflowRunId: runId,
        runNodeId: sourceNode.runNodeId,
        artifactType: 'report',
        contentType: 'markdown',
        content: 'approved',
        metadata: null,
        createdAt: '2026-01-01T00:00:01.000Z',
      })
      .returning({ id: phaseArtifacts.id })
      .get();

    db.insert(phaseArtifacts)
      .values({
        workflowRunId: runId,
        runNodeId: sourceNode.runNodeId,
        artifactType: 'log',
        contentType: 'json',
        content: '{"stderr":"command failed"}',
        metadata: {
          kind: FAILED_COMMAND_OUTPUT_ARTIFACT_KIND,
          exitCode: 1,
        },
        createdAt: '2026-01-01T00:00:03.000Z',
      })
      .run();

    const latestArtifacts = loadLatestArtifactsByRunNodeId(db, runId);
    expect(latestArtifacts.get(sourceNode.runNodeId)).toEqual({
      id: reportArtifact.id,
      createdAt: '2026-01-01T00:00:01.000Z',
    });
  });

  it('does not mark a routing decision stale when only failed command output is newer', () => {
    const { db, runId, sourceNode } = createSingleNodeRun();

    db.insert(phaseArtifacts)
      .values({
        workflowRunId: runId,
        runNodeId: sourceNode.runNodeId,
        artifactType: 'report',
        contentType: 'markdown',
        content: 'approved',
        metadata: null,
        createdAt: '2026-01-01T00:00:01.000Z',
      })
      .run();

    db.insert(phaseArtifacts)
      .values({
        workflowRunId: runId,
        runNodeId: sourceNode.runNodeId,
        artifactType: 'log',
        contentType: 'json',
        content: '{"stderr":"command failed"}',
        metadata: {
          kind: FAILED_COMMAND_OUTPUT_ARTIFACT_KIND,
          exitCode: 1,
        },
        createdAt: '2026-01-01T00:00:03.000Z',
      })
      .run();

    const decision: RoutingDecisionRow = {
      id: 99,
      runNodeId: sourceNode.runNodeId,
      decisionType: 'approved',
      createdAt: '2026-01-01T00:00:02.000Z',
      attempt: sourceNode.attempt,
    };

    const resolvedDecision = resolveApplicableRoutingDecision(
      sourceNode,
      new Map([[sourceNode.runNodeId, decision]]),
      loadLatestArtifactsByRunNodeId(db, runId),
    );

    expect(resolvedDecision).toEqual(decision);
  });
});
