import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDatabase } from './connection.js';
import { migrateDatabase } from './migrate.js';
import {
  guardDefinitions,
  phaseArtifacts,
  promptTemplates,
  routingDecisions,
  runNodes,
  treeEdges,
  treeNodes,
  workflowRuns,
  workflowTrees,
} from './schema.js';

type Seed = {
  guardDefinitionId: number;
  promptTemplateId: number;
  runId: number;
  sourceNodeId: number;
  targetNodeId: number;
  treeId: number;
};

function seedTreeState(db: ReturnType<typeof createDatabase>, keyPrefix = 'design'): Seed {
  const tree = db
    .insert(workflowTrees)
    .values({
      treeKey: `${keyPrefix}_tree`,
      version: 1,
      name: `${keyPrefix} tree`,
    })
    .returning({ id: workflowTrees.id })
    .get();

  const promptTemplate = db
    .insert(promptTemplates)
    .values({
      templateKey: `${keyPrefix}_prompt`,
      version: 1,
      content: 'Create a design report',
      contentType: 'markdown',
    })
    .returning({ id: promptTemplates.id })
    .get();

  const guardDefinition = db
    .insert(guardDefinitions)
    .values({
      guardKey: `${keyPrefix}_needs_revision`,
      version: 1,
      expression: { field: 'decision', operator: '==', value: 'changes_requested' },
    })
    .returning({ id: guardDefinitions.id })
    .get();

  const sourceNode = db
    .insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: `${keyPrefix}_design`,
      nodeType: 'agent',
      provider: 'codex',
      promptTemplateId: promptTemplate.id,
      maxRetries: 1,
      sequenceIndex: 1,
    })
    .returning({ id: treeNodes.id })
    .get();

  const targetNode = db
    .insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: `${keyPrefix}_implement`,
      nodeType: 'agent',
      provider: 'codex',
      promptTemplateId: promptTemplate.id,
      maxRetries: 2,
      sequenceIndex: 2,
    })
    .returning({ id: treeNodes.id })
    .get();

  const run = db
    .insert(workflowRuns)
    .values({
      workflowTreeId: tree.id,
      status: 'pending',
    })
    .returning({ id: workflowRuns.id })
    .get();

  return {
    treeId: tree.id,
    promptTemplateId: promptTemplate.id,
    guardDefinitionId: guardDefinition.id,
    sourceNodeId: sourceNode.id,
    targetNodeId: targetNode.id,
    runId: run.id,
  };
}

describe('database schema hardening', () => {
  it('runs migrations reproducibly in repeated executions without dropping existing data', () => {
    const db = createDatabase(':memory:');

    migrateDatabase(db);

    db.insert(workflowTrees).values({
      treeKey: 'persisted_tree',
      version: 1,
      name: 'Persisted tree',
    }).run();

    expect(() => migrateDatabase(db)).not.toThrow();

    const trees = db.select({ id: workflowTrees.id }).from(workflowTrees).all();
    expect(trees).toHaveLength(1);
  });

  it('supports a full SQL representation of a design tree and execution artifacts', () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);

    const seed = seedTreeState(db);

    const edge = db
      .insert(treeEdges)
      .values({
        workflowTreeId: seed.treeId,
        sourceNodeId: seed.sourceNodeId,
        targetNodeId: seed.targetNodeId,
        priority: 10,
        auto: 0,
        guardDefinitionId: seed.guardDefinitionId,
      })
      .returning({ id: treeEdges.id })
      .get();

    const runNode = db
      .insert(runNodes)
      .values({
        workflowRunId: seed.runId,
        treeNodeId: seed.sourceNodeId,
        nodeKey: 'design',
        status: 'pending',
        sequenceIndex: 1,
      })
      .returning({ id: runNodes.id })
      .get();

    const decision = db
      .insert(routingDecisions)
      .values({
        workflowRunId: seed.runId,
        runNodeId: runNode.id,
        decisionType: 'changes_requested',
      })
      .returning({ id: routingDecisions.id })
      .get();

    const artifact = db
      .insert(phaseArtifacts)
      .values({
        workflowRunId: seed.runId,
        runNodeId: runNode.id,
        artifactType: 'report',
        contentType: 'markdown',
        content: '# Report',
      })
      .returning({ id: phaseArtifacts.id })
      .get();

    expect(edge.id).toBeGreaterThan(0);
    expect(decision.id).toBeGreaterThan(0);
    expect(artifact.id).toBeGreaterThan(0);
  });

  it('enforces foreign keys for relational execution records', () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    const seed = seedTreeState(db);

    expect(() =>
      db.insert(treeEdges).values({
        workflowTreeId: seed.treeId,
        sourceNodeId: 999_999,
        targetNodeId: seed.targetNodeId,
        priority: 0,
        auto: 0,
        guardDefinitionId: seed.guardDefinitionId,
      }).run(),
    ).toThrow();
  });

  it('rejects cross-tree run-node and edge relationships', () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);

    const first = seedTreeState(db, 'first');
    const second = seedTreeState(db, 'second');

    expect(() =>
      db.insert(runNodes).values({
        workflowRunId: first.runId,
        treeNodeId: second.sourceNodeId,
        nodeKey: 'cross_tree_node',
        status: 'pending',
        sequenceIndex: 99,
      }).run(),
    ).toThrow();

    expect(() =>
      db.insert(treeEdges).values({
        workflowTreeId: first.treeId,
        sourceNodeId: first.sourceNodeId,
        targetNodeId: second.targetNodeId,
        priority: 99,
        auto: 0,
        guardDefinitionId: first.guardDefinitionId,
      }).run(),
    ).toThrow();
  });

  it('rejects routing decisions and artifacts bound to a different run than their run-node', () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);

    const first = seedTreeState(db, 'first');
    const second = seedTreeState(db, 'second');
    const firstRunNode = db
      .insert(runNodes)
      .values({
        workflowRunId: first.runId,
        treeNodeId: first.sourceNodeId,
        nodeKey: 'first_design',
        status: 'pending',
        sequenceIndex: 1,
      })
      .returning({ id: runNodes.id })
      .get();

    expect(() =>
      db.insert(routingDecisions).values({
        workflowRunId: second.runId,
        runNodeId: firstRunNode.id,
        decisionType: 'approved',
      }).run(),
    ).toThrow();

    expect(() =>
      db.insert(phaseArtifacts).values({
        workflowRunId: second.runId,
        runNodeId: firstRunNode.id,
        artifactType: 'report',
        contentType: 'text',
        content: 'cross-run artifact should fail',
      }).run(),
    ).toThrow();
  });

  it('enforces uniqueness for node identity and run sequence ordering', () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    const seed = seedTreeState(db);

    expect(() =>
      db.insert(treeNodes).values({
        workflowTreeId: seed.treeId,
        nodeKey: 'design_design',
        nodeType: 'agent',
        provider: 'codex',
        promptTemplateId: seed.promptTemplateId,
        sequenceIndex: 99,
      }).run(),
    ).toThrow();

    db.insert(runNodes).values({
      workflowRunId: seed.runId,
      treeNodeId: seed.sourceNodeId,
      nodeKey: 'design',
      status: 'pending',
      sequenceIndex: 1,
    }).run();

    expect(() =>
      db.insert(runNodes).values({
        workflowRunId: seed.runId,
        treeNodeId: seed.targetNodeId,
        nodeKey: 'implement',
        status: 'pending',
        sequenceIndex: 1,
      }).run(),
    ).toThrow();
  });

  it('enforces enum and lifecycle checks at the DB layer', () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    const seed = seedTreeState(db);

    expect(() =>
      db.insert(treeNodes).values({
        workflowTreeId: seed.treeId,
        nodeKey: 'bad-node',
        nodeType: 'invalid',
        sequenceIndex: 20,
      }).run(),
    ).toThrow();

    const runNode = db
      .insert(runNodes)
      .values({
        workflowRunId: seed.runId,
        treeNodeId: seed.sourceNodeId,
        nodeKey: 'design',
        status: 'pending',
        sequenceIndex: 1,
      })
      .returning({ id: runNodes.id })
      .get();

    expect(() =>
      db.insert(routingDecisions).values({
        workflowRunId: seed.runId,
        runNodeId: runNode.id,
        decisionType: 'unknown',
      }).run(),
    ).toThrow();

    expect(() =>
      db.update(runNodes).set({ status: 'running', startedAt: null }).where(eq(runNodes.id, runNode.id)).run(),
    ).toThrow();
  });

  it('creates required performance indexes for run and artifact hot paths', () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);

    const indexes = db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name`,
    );
    const names = new Set(indexes.map(indexRow => indexRow.name));

    expect(names.has('run_nodes_run_id_status_idx')).toBe(true);
    expect(names.has('run_nodes_run_id_sequence_idx')).toBe(true);
    expect(names.has('run_nodes_run_id_id_uq')).toBe(true);
    expect(names.has('tree_nodes_node_key_idx')).toBe(true);
    expect(names.has('phase_artifacts_created_at_idx')).toBe(true);
    expect(names.has('routing_decisions_created_at_idx')).toBe(true);
  });
});
