import { describe, expect, it } from 'vitest';
import { createDatabase } from './connection.js';
import { migrateDatabase } from './migrate.js';
import {
  guardDefinitions,
  promptTemplates,
  treeEdges,
  treeNodes,
  workflowTrees,
} from './schema.js';
import {
  AmbiguousWorkflowTreeVersionError,
  WorkflowTreeNotFoundError,
  loadWorkflowTreeTopology,
  materializeWorkflowRunFromTree,
  selectActiveWorkflowTreeVersion,
} from './workflowPlanner.js';

function seedDesignTreeVersions() {
  const db = createDatabase(':memory:');
  migrateDatabase(db);

  const oldVersionTree = db
    .insert(workflowTrees)
    .values({
      treeKey: 'design_tree',
      version: 1,
      name: 'Design tree v1',
    })
    .returning({ id: workflowTrees.id })
    .get();

  const activeTree = db
    .insert(workflowTrees)
    .values({
      treeKey: 'design_tree',
      version: 2,
      name: 'Design tree v2',
    })
    .returning({ id: workflowTrees.id })
    .get();

  const designPrompt = db
    .insert(promptTemplates)
    .values({
      templateKey: 'design_prompt',
      version: 1,
      content: 'Design prompt',
      contentType: 'markdown',
    })
    .returning({ id: promptTemplates.id })
    .get();

  const implementPrompt = db
    .insert(promptTemplates)
    .values({
      templateKey: 'implement_prompt',
      version: 1,
      content: 'Implement prompt',
      contentType: 'markdown',
    })
    .returning({ id: promptTemplates.id })
    .get();

  const reviewPrompt = db
    .insert(promptTemplates)
    .values({
      templateKey: 'review_prompt',
      version: 1,
      content: 'Review prompt',
      contentType: 'markdown',
    })
    .returning({ id: promptTemplates.id })
    .get();

  const reviewNode = db
    .insert(treeNodes)
    .values({
      workflowTreeId: activeTree.id,
      nodeKey: 'review',
      nodeType: 'agent',
      provider: 'claude',
      promptTemplateId: reviewPrompt.id,
      maxRetries: 1,
      sequenceIndex: 30,
    })
    .returning({ id: treeNodes.id })
    .get();

  const designNode = db
    .insert(treeNodes)
    .values({
      workflowTreeId: activeTree.id,
      nodeKey: 'design',
      nodeType: 'agent',
      provider: 'codex',
      promptTemplateId: designPrompt.id,
      maxRetries: 2,
      sequenceIndex: 10,
    })
    .returning({ id: treeNodes.id })
    .get();

  const implementNode = db
    .insert(treeNodes)
    .values({
      workflowTreeId: activeTree.id,
      nodeKey: 'implement',
      nodeType: 'agent',
      provider: 'codex',
      promptTemplateId: implementPrompt.id,
      maxRetries: 0,
      sequenceIndex: 20,
    })
    .returning({ id: treeNodes.id })
    .get();

  const guard = db
    .insert(guardDefinitions)
    .values({
      guardKey: 'approved',
      version: 1,
      expression: {
        field: 'decision',
        operator: '==',
        value: 'approved',
      },
    })
    .returning({ id: guardDefinitions.id })
    .get();

  db.insert(treeEdges)
    .values({
      workflowTreeId: activeTree.id,
      sourceNodeId: designNode.id,
      targetNodeId: implementNode.id,
      priority: 1,
      auto: 1,
      guardDefinitionId: null,
    })
    .run();

  db.insert(treeEdges)
    .values({
      workflowTreeId: activeTree.id,
      sourceNodeId: implementNode.id,
      targetNodeId: reviewNode.id,
      priority: 1,
      auto: 0,
      guardDefinitionId: guard.id,
    })
    .run();

  return { db, oldVersionTreeId: oldVersionTree.id, activeTreeId: activeTree.id };
}

function seedEmptyTree() {
  const db = createDatabase(':memory:');
  migrateDatabase(db);

  db.insert(workflowTrees)
    .values({
      treeKey: 'empty_tree',
      version: 1,
      name: 'Empty tree',
    })
    .run();

  return db;
}

function seedCyclicTree() {
  const db = createDatabase(':memory:');
  migrateDatabase(db);

  const tree = db
    .insert(workflowTrees)
    .values({
      treeKey: 'cyclic_tree',
      version: 1,
      name: 'Cyclic tree',
    })
    .returning({ id: workflowTrees.id })
    .get();

  const designNode = db
    .insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'design',
      nodeType: 'agent',
      provider: 'codex',
      sequenceIndex: 10,
    })
    .returning({ id: treeNodes.id })
    .get();

  const implementNode = db
    .insert(treeNodes)
    .values({
      workflowTreeId: tree.id,
      nodeKey: 'implement',
      nodeType: 'agent',
      provider: 'codex',
      sequenceIndex: 20,
    })
    .returning({ id: treeNodes.id })
    .get();

  db.insert(treeEdges)
    .values({
      workflowTreeId: tree.id,
      sourceNodeId: designNode.id,
      targetNodeId: implementNode.id,
      priority: 1,
      auto: 1,
      guardDefinitionId: null,
    })
    .run();

  db.insert(treeEdges)
    .values({
      workflowTreeId: tree.id,
      sourceNodeId: implementNode.id,
      targetNodeId: designNode.id,
      priority: 1,
      auto: 1,
      guardDefinitionId: null,
    })
    .run();

  return db;
}

describe('workflow planner/materializer', () => {
  it('throws for missing tree keys', () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);

    expect(() => materializeWorkflowRunFromTree(db, { treeKey: 'missing_tree' })).toThrow(WorkflowTreeNotFoundError);
  });

  it('throws for ambiguous active tree version candidates', () => {
    expect(() =>
      selectActiveWorkflowTreeVersion(
        [
          { id: 12, treeKey: 'design_tree', version: 3, name: 'tree-a', description: null },
          { id: 13, treeKey: 'design_tree', version: 3, name: 'tree-b', description: null },
        ],
        'design_tree',
      ),
    ).toThrow(AmbiguousWorkflowTreeVersionError);
  });

  it('loads an explicit tree version and throws when explicit version is missing', () => {
    const { db, oldVersionTreeId, activeTreeId } = seedDesignTreeVersions();

    const explicitOldVersionTopology = loadWorkflowTreeTopology(db, { treeKey: 'design_tree', treeVersion: 1 });
    expect(explicitOldVersionTopology.tree.id).toBe(oldVersionTreeId);
    expect(explicitOldVersionTopology.tree.version).toBe(1);

    const explicitActiveVersionTopology = loadWorkflowTreeTopology(db, { treeKey: 'design_tree', treeVersion: 2 });
    expect(explicitActiveVersionTopology.tree.id).toBe(activeTreeId);
    expect(explicitActiveVersionTopology.tree.version).toBe(2);

    expect(() => loadWorkflowTreeTopology(db, { treeKey: 'design_tree', treeVersion: 99 })).toThrow(
      WorkflowTreeNotFoundError,
    );
  });

  it('materializes runs for an explicit tree version and throws when explicit version is missing', () => {
    const { db, oldVersionTreeId, activeTreeId } = seedDesignTreeVersions();

    const explicitOldVersionRun = materializeWorkflowRunFromTree(db, { treeKey: 'design_tree', treeVersion: 1 });
    expect(explicitOldVersionRun.topology.tree.id).toBe(oldVersionTreeId);
    expect(explicitOldVersionRun.topology.tree.version).toBe(1);
    expect(explicitOldVersionRun.run.workflowTreeId).toBe(oldVersionTreeId);
    expect(explicitOldVersionRun.runNodes).toEqual([]);

    const explicitActiveVersionRun = materializeWorkflowRunFromTree(db, { treeKey: 'design_tree', treeVersion: 2 });
    expect(explicitActiveVersionRun.topology.tree.id).toBe(activeTreeId);
    expect(explicitActiveVersionRun.topology.tree.version).toBe(2);
    expect(explicitActiveVersionRun.run.workflowTreeId).toBe(activeTreeId);
    expect(explicitActiveVersionRun.runNodes.map(node => node.nodeKey)).toEqual(['design', 'implement', 'review']);

    expect(() => materializeWorkflowRunFromTree(db, { treeKey: 'design_tree', treeVersion: 99 })).toThrow(
      WorkflowTreeNotFoundError,
    );
  });

  it('materializes runs for trees that have no nodes', () => {
    const db = seedEmptyTree();

    const topology = loadWorkflowTreeTopology(db, { treeKey: 'empty_tree' });
    expect(topology.nodes).toEqual([]);
    expect(topology.edges).toEqual([]);
    expect(topology.initialRunnableNodeKeys).toEqual([]);

    const run = materializeWorkflowRunFromTree(db, { treeKey: 'empty_tree' });
    expect(run.initialRunnableNodeKeys).toEqual([]);
    expect(run.run.status).toBe('pending');
    expect(run.runNodes).toEqual([]);
  });

  it('materializes cyclic trees with no initial runnable nodes', () => {
    const db = seedCyclicTree();

    const topology = loadWorkflowTreeTopology(db, { treeKey: 'cyclic_tree' });
    expect(topology.initialRunnableNodeKeys).toEqual([]);
    expect(topology.nodes.map(node => node.nodeKey)).toEqual(['design', 'implement']);

    const run = materializeWorkflowRunFromTree(db, { treeKey: 'cyclic_tree' });
    expect(run.initialRunnableNodeKeys).toEqual([]);
    expect(run.runNodes.map(node => node.nodeKey)).toEqual(['design', 'implement']);
    expect(run.runNodes.map(node => node.isInitialRunnable)).toEqual([false, false]);
  });

  it('materializes deterministic run nodes from the active SQL tree topology', () => {
    const { db, activeTreeId } = seedDesignTreeVersions();

    const firstRun = materializeWorkflowRunFromTree(db, { treeKey: 'design_tree' });
    const secondRun = materializeWorkflowRunFromTree(db, { treeKey: 'design_tree' });

    expect(firstRun.topology.tree.id).toBe(activeTreeId);
    expect(firstRun.topology.tree.version).toBe(2);
    expect(firstRun.initialRunnableNodeKeys).toEqual(['design']);

    expect(firstRun.run.status).toBe('pending');
    expect(firstRun.runNodes.map(node => node.status)).toEqual(['pending', 'pending', 'pending']);
    expect(firstRun.runNodes.map(node => node.nodeKey)).toEqual(['design', 'implement', 'review']);
    expect(firstRun.runNodes.map(node => node.sequenceIndex)).toEqual([10, 20, 30]);
    expect(firstRun.runNodes.map(node => node.isInitialRunnable)).toEqual([true, false, false]);

    expect(secondRun.runNodes.map(node => node.nodeKey)).toEqual(firstRun.runNodes.map(node => node.nodeKey));
    expect(secondRun.runNodes.map(node => node.sequenceIndex)).toEqual(firstRun.runNodes.map(node => node.sequenceIndex));
  });

  it('materializes running runs with default and explicit startedAt timestamps', () => {
    const { db } = seedDesignTreeVersions();

    const runningRun = materializeWorkflowRunFromTree(db, { treeKey: 'design_tree', runStatus: 'running' });
    expect(runningRun.run.status).toBe('running');
    expect(runningRun.run.startedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/,
    );

    const explicitStartedAt = '2025-01-02T03:04:05.678Z';
    const runningRunWithExplicitStart = materializeWorkflowRunFromTree(db, {
      treeKey: 'design_tree',
      runStatus: 'running',
      runStartedAt: explicitStartedAt,
    });
    expect(runningRunWithExplicitStart.run.status).toBe('running');
    expect(runningRunWithExplicitStart.run.startedAt).toBe(explicitStartedAt);
  });

  it('loads topology within the transaction boundary during materialization', () => {
    const { db } = seedDesignTreeVersions();
    let enteredTransaction = false;

    const transactionOnlyDb = new Proxy(db, {
      get(target, property) {
        if (property === 'transaction') {
          return (callback: (tx: unknown) => unknown) =>
            target.transaction((tx) => {
              enteredTransaction = true;
              return callback(tx);
            });
        }

        throw new Error(`Unexpected outer database access: ${String(property)}`);
      },
    });

    const run = materializeWorkflowRunFromTree(transactionOnlyDb as typeof db, { treeKey: 'design_tree' });
    expect(enteredTransaction).toBe(true);
    expect(run.runNodes.map(node => node.nodeKey)).toEqual(['design', 'implement', 'review']);
  });
});
