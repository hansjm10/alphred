import { describe, expect, it } from 'vitest';
import { createDatabase, migrateDatabase, promptTemplates, treeNodes, workflowTrees } from '@alphred/db';
import { createSqlWorkflowPlanner } from './sqlWorkflowPlanner.js';

function seedSingleNodeTree() {
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
      content: 'Create design',
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

  return db;
}

describe('createSqlWorkflowPlanner', () => {
  it('exposes topology loading and run materialization from core', () => {
    const db = seedSingleNodeTree();
    const planner = createSqlWorkflowPlanner(db);

    const topology = planner.loadTopology({ treeKey: 'design_tree' });
    expect(topology.tree.version).toBe(1);
    expect(topology.nodes.map(node => node.nodeKey)).toEqual(['design']);

    const run = planner.materializeRun({ treeKey: 'design_tree' });
    expect(run.run.status).toBe('pending');
    expect(run.initialRunnableNodeKeys).toEqual(['design']);
    expect(run.runNodes).toHaveLength(1);
    expect(run.runNodes[0].nodeKey).toBe('design');
    expect(run.runNodes[0].isInitialRunnable).toBe(true);
  });
});
