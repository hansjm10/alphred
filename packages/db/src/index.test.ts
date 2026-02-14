import { describe, expect, it } from 'vitest';
import * as db from './index.js';

describe('db index exports', () => {
  it('re-exports database setup and schema tables', () => {
    expect(typeof db.createDatabase).toBe('function');
    expect(typeof db.migrateDatabase).toBe('function');
    expect(typeof db.transitionRunNodeStatus).toBe('function');
    expect(typeof db.loadWorkflowTreeTopology).toBe('function');
    expect(typeof db.materializeWorkflowRunFromTree).toBe('function');
    expect(db.workflowTrees).toBeDefined();
    expect(db.treeNodes).toBeDefined();
    expect(db.treeEdges).toBeDefined();
    expect(db.runNodes).toBeDefined();
    expect(db.routingDecisions).toBeDefined();
    expect(db.phaseArtifacts).toBeDefined();
  });
});
