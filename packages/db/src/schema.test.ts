import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDatabase } from './connection.js';
import { migrateDatabase } from './migrate.js';
import {
  guardDefinitions,
  phaseArtifacts,
  promptTemplates,
  repositories,
  runNodeDiagnostics,
  runNodeStreamEvents,
  routingDecisions,
  runWorktrees,
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
  sourceNodeKey: string;
  targetNodeId: number;
  targetNodeKey: string;
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
    sourceNodeKey: `${keyPrefix}_design`,
    targetNodeId: targetNode.id,
    targetNodeKey: `${keyPrefix}_implement`,
    runId: run.id,
  };
}

describe('database schema hardening', () => {
  it('adds workflow_trees columns when migrating a legacy workflow_trees table', () => {
    const db = createDatabase(':memory:');

    db.run(sql`CREATE TABLE workflow_trees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tree_key TEXT NOT NULL,
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`);

    expect(() => migrateDatabase(db)).not.toThrow();

    const columns = db.all<{ name: string }>(sql`SELECT name FROM pragma_table_info('workflow_trees') ORDER BY cid`);
    const columnNames = columns.map(column => column.name);
    expect(columnNames).toContain('status');
    expect(columnNames).toContain('version_notes');
    expect(columnNames).toContain('draft_revision');
  });

  it('adds tree_nodes columns when migrating a legacy tree_nodes table', () => {
    const db = createDatabase(':memory:');

    db.run(sql`CREATE TABLE workflow_trees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tree_key TEXT NOT NULL,
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`);

    db.run(sql`CREATE TABLE tree_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_tree_id INTEGER NOT NULL REFERENCES workflow_trees(id) ON DELETE CASCADE,
      node_key TEXT NOT NULL,
      node_type TEXT NOT NULL,
      provider TEXT,
      prompt_template_id INTEGER,
      max_retries INTEGER NOT NULL DEFAULT 0,
      sequence_index INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`);

    expect(() => migrateDatabase(db)).not.toThrow();

    const columns = db.all<{ name: string }>(sql`SELECT name FROM pragma_table_info('tree_nodes') ORDER BY cid`);
    const columnNames = columns.map(column => column.name);
    expect(columnNames).toContain('display_name');
    expect(columnNames).toContain('position_x');
    expect(columnNames).toContain('position_y');
    expect(columnNames).toContain('model');
    expect(columnNames).toContain('execution_permissions');
    expect(columnNames).toContain('error_handler_config');
  });

  it('persists nullable and custom tree_nodes.error_handler_config payloads', () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);

    const tree = db
      .insert(workflowTrees)
      .values({
        treeKey: 'error_handler_config_tree',
        version: 1,
        name: 'Error Handler Config Tree',
      })
      .returning({ id: workflowTrees.id })
      .get();

    const promptTemplate = db
      .insert(promptTemplates)
      .values({
        templateKey: 'error_handler_config_prompt',
        version: 1,
        content: 'Summarize retry failure context',
        contentType: 'markdown',
      })
      .returning({ id: promptTemplates.id })
      .get();

    db.insert(treeNodes)
      .values([
        {
          workflowTreeId: tree.id,
          nodeKey: 'default-handler',
          nodeType: 'agent',
          provider: 'codex',
          promptTemplateId: promptTemplate.id,
          maxRetries: 1,
          sequenceIndex: 1,
          errorHandlerConfig: null,
        },
        {
          workflowTreeId: tree.id,
          nodeKey: 'custom-handler',
          nodeType: 'agent',
          provider: 'codex',
          promptTemplateId: promptTemplate.id,
          maxRetries: 1,
          sequenceIndex: 2,
          errorHandlerConfig: {
            mode: 'custom',
            prompt: 'Use a different strategy',
            model: 'gpt-5-codex-mini',
            provider: 'codex',
            maxInputChars: 1200,
          },
        },
      ])
      .run();

    const rows = db
      .select({
        nodeKey: treeNodes.nodeKey,
        errorHandlerConfig: treeNodes.errorHandlerConfig,
      })
      .from(treeNodes)
      .where(eq(treeNodes.workflowTreeId, tree.id))
      .orderBy(treeNodes.sequenceIndex)
      .all();

    expect(rows).toEqual([
      {
        nodeKey: 'default-handler',
        errorHandlerConfig: null,
      },
      {
        nodeKey: 'custom-handler',
        errorHandlerConfig: {
          mode: 'custom',
          prompt: 'Use a different strategy',
          model: 'gpt-5-codex-mini',
          provider: 'codex',
          maxInputChars: 1200,
        },
      },
    ]);
  });

  it('adds repositories.branch_template when migrating a legacy repositories table', () => {
    const db = createDatabase(':memory:');

    db.run(sql`CREATE TABLE repositories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      remote_url TEXT NOT NULL,
      remote_ref TEXT NOT NULL,
      default_branch TEXT NOT NULL DEFAULT 'main',
      local_path TEXT,
      clone_status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`);

    expect(() => migrateDatabase(db)).not.toThrow();

    const columns = db.all<{ name: string }>(sql`SELECT name FROM pragma_table_info('repositories') ORDER BY cid`);
    expect(columns.map(column => column.name)).toContain('branch_template');
  });

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

  it('allows only one draft workflow tree per tree key', () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);

    db.insert(workflowTrees).values({
      treeKey: 'single-draft-tree',
      version: 1,
      status: 'draft',
      name: 'Single Draft Tree',
    }).run();

    expect(() =>
      db.insert(workflowTrees).values({
        treeKey: 'single-draft-tree',
        version: 2,
        status: 'published',
        name: 'Single Draft Tree',
      }).run(),
    ).not.toThrow();

    expect(() =>
      db.insert(workflowTrees).values({
        treeKey: 'single-draft-tree',
        version: 3,
        status: 'draft',
        name: 'Single Draft Tree',
      }).run(),
    ).toThrow();
  });

  it('seeds agent model catalog defaults including GPT-5.3-Codex', () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);

    const models = db.all<{
      provider: string;
      model_key: string;
      display_name: string;
      is_default: number;
    }>(sql`SELECT provider, model_key, display_name, is_default FROM agent_models ORDER BY provider, model_key`);

    expect(models).toEqual(
      expect.arrayContaining([
        {
          provider: 'codex',
          model_key: 'gpt-5.3-codex',
          display_name: 'GPT-5.3-Codex',
          is_default: 1,
        },
      ]),
    );
  });

  it('refreshes run-node transition trigger definitions on migration reruns', () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    const seed = seedTreeState(db, 'trigger_refresh');

    const completedNode = db
      .insert(runNodes)
      .values({
        workflowRunId: seed.runId,
        treeNodeId: seed.sourceNodeId,
        nodeKey: seed.sourceNodeKey,
        status: 'pending',
        sequenceIndex: 1,
      })
      .returning({ id: runNodes.id })
      .get();

    const skippedNode = db
      .insert(runNodes)
      .values({
        workflowRunId: seed.runId,
        treeNodeId: seed.targetNodeId,
        nodeKey: seed.targetNodeKey,
        status: 'pending',
        sequenceIndex: 2,
      })
      .returning({ id: runNodes.id })
      .get();

    const failedTreeNode = db
      .insert(treeNodes)
      .values({
        workflowTreeId: seed.treeId,
        nodeKey: `${seed.targetNodeKey}_retry`,
        nodeType: 'agent',
        provider: 'codex',
        promptTemplateId: seed.promptTemplateId,
        maxRetries: 1,
        sequenceIndex: 3,
      })
      .returning({ id: treeNodes.id, nodeKey: treeNodes.nodeKey })
      .get();

    const failedNode = db
      .insert(runNodes)
      .values({
        workflowRunId: seed.runId,
        treeNodeId: failedTreeNode.id,
        nodeKey: failedTreeNode.nodeKey,
        status: 'pending',
        sequenceIndex: 3,
      })
      .returning({ id: runNodes.id })
      .get();

    db.run(sql`DROP TRIGGER IF EXISTS run_nodes_status_transition_update_ck`);
    db.run(sql`CREATE TRIGGER run_nodes_status_transition_update_ck
      BEFORE UPDATE OF status ON run_nodes
      FOR EACH ROW
      WHEN (
        NEW.status <> OLD.status
        AND NOT (
          (OLD.status = 'pending' AND NEW.status IN ('running', 'skipped', 'cancelled'))
          OR
          (OLD.status = 'running' AND NEW.status IN ('completed', 'failed', 'cancelled'))
          OR
          (OLD.status = 'failed' AND NEW.status = 'running')
        )
      )
      BEGIN
        SELECT RAISE(ABORT, 'run_nodes status transition is not allowed');
      END`);

    db
      .update(runNodes)
      .set({ status: 'running', startedAt: '2026-01-01T00:00:00.000Z' })
      .where(eq(runNodes.id, completedNode.id))
      .run();
    db
      .update(runNodes)
      .set({ status: 'completed', completedAt: '2026-01-01T00:01:00.000Z' })
      .where(eq(runNodes.id, completedNode.id))
      .run();
    db
      .update(runNodes)
      .set({ status: 'skipped', completedAt: '2026-01-01T00:01:30.000Z' })
      .where(eq(runNodes.id, skippedNode.id))
      .run();
    db
      .update(runNodes)
      .set({ status: 'running', startedAt: '2026-01-01T00:02:00.000Z' })
      .where(eq(runNodes.id, failedNode.id))
      .run();
    db
      .update(runNodes)
      .set({ status: 'failed', completedAt: '2026-01-01T00:03:00.000Z' })
      .where(eq(runNodes.id, failedNode.id))
      .run();

    expect(() =>
      db
        .update(runNodes)
        .set({ status: 'pending', startedAt: null, completedAt: null })
        .where(eq(runNodes.id, completedNode.id))
        .run(),
    ).toThrow('run_nodes status transition is not allowed');

    expect(() =>
      db
        .update(runNodes)
        .set({ status: 'pending', startedAt: null, completedAt: null })
        .where(eq(runNodes.id, skippedNode.id))
        .run(),
    ).toThrow('run_nodes status transition is not allowed');

    expect(() =>
      db
        .update(runNodes)
        .set({ status: 'pending', startedAt: null, completedAt: null })
        .where(eq(runNodes.id, failedNode.id))
        .run(),
    ).toThrow('run_nodes status transition is not allowed');

    expect(() => migrateDatabase(db)).not.toThrow();

    expect(() =>
      db
        .update(runNodes)
        .set({ status: 'pending', startedAt: null, completedAt: null })
        .where(eq(runNodes.id, completedNode.id))
        .run(),
    ).not.toThrow();

    expect(() =>
      db
        .update(runNodes)
        .set({ status: 'pending', startedAt: null, completedAt: null })
        .where(eq(runNodes.id, skippedNode.id))
        .run(),
    ).not.toThrow();

    expect(() =>
      db
        .update(runNodes)
        .set({ status: 'pending', startedAt: null, completedAt: null })
        .where(eq(runNodes.id, failedNode.id))
        .run(),
    ).not.toThrow();
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
        nodeKey: seed.sourceNodeKey,
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

    const repository = db
      .insert(repositories)
      .values({
        name: 'design-repo',
        provider: 'github',
        remoteUrl: 'https://github.com/acme/design-repo.git',
        remoteRef: 'acme/design-repo',
        defaultBranch: 'main',
        cloneStatus: 'cloned',
      })
      .returning({ id: repositories.id })
      .get();

    const runWorktree = db
      .insert(runWorktrees)
      .values({
        workflowRunId: seed.runId,
        repositoryId: repository.id,
        worktreePath: '/tmp/alphred/worktrees/design-tree-1',
        branch: 'alphred/design_tree/1',
        commitHash: 'abc123',
        status: 'active',
      })
      .returning({ id: runWorktrees.id })
      .get();

    expect(edge.id).toBeGreaterThan(0);
    expect(decision.id).toBeGreaterThan(0);
    expect(artifact.id).toBeGreaterThan(0);
    expect(runWorktree.id).toBeGreaterThan(0);
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
        nodeKey: second.sourceNodeKey,
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

  it('enforces workflow-run completion timestamps against run status', () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    const seed = seedTreeState(db);

    expect(() =>
      db.insert(workflowRuns).values({
        workflowTreeId: seed.treeId,
        status: 'completed',
      }).run(),
    ).toThrow();

    expect(() =>
      db.insert(workflowRuns).values({
        workflowTreeId: seed.treeId,
        status: 'running',
        completedAt: '2026-01-01T00:00:00.000Z',
      }).run(),
    ).toThrow();

    expect(() =>
      db
        .update(workflowRuns)
        .set({
          status: 'failed',
          completedAt: '2026-01-01T00:01:00.000Z',
        })
        .where(eq(workflowRuns.id, seed.runId))
        .run(),
    ).not.toThrow();
  });

  it('enforces run-worktree status and removal timestamp invariants', () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    const seed = seedTreeState(db, 'run_worktree_constraints');
    const repository = db
      .insert(repositories)
      .values({
        name: 'run-worktree-constraints-repo',
        provider: 'github',
        remoteUrl: 'https://github.com/acme/run-worktree-constraints-repo.git',
        remoteRef: 'acme/run-worktree-constraints-repo',
        defaultBranch: 'main',
        cloneStatus: 'cloned',
      })
      .returning({ id: repositories.id })
      .get();

    expect(() =>
      db.insert(runWorktrees).values({
        workflowRunId: seed.runId,
        repositoryId: repository.id,
        worktreePath: '/tmp/alphred/worktrees/run-worktree-invalid-status',
        branch: 'alphred/design_tree/invalid-status',
        status: 'stale',
      }).run(),
    ).toThrow();

    expect(() =>
      db.insert(runWorktrees).values({
        workflowRunId: seed.runId,
        repositoryId: repository.id,
        worktreePath: '/tmp/alphred/worktrees/run-worktree-active-has-removed-at',
        branch: 'alphred/design_tree/active-has-removed-at',
        status: 'active',
        removedAt: '2026-01-01T00:00:00.000Z',
      }).run(),
    ).toThrow();

    expect(() =>
      db.insert(runWorktrees).values({
        workflowRunId: seed.runId,
        repositoryId: repository.id,
        worktreePath: '/tmp/alphred/worktrees/run-worktree-removed-missing-removed-at',
        branch: 'alphred/design_tree/removed-missing-removed-at',
        status: 'removed',
      }).run(),
    ).toThrow();
  });

  it('enforces tree edge transition mode combinations', () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    const seed = seedTreeState(db);

    expect(() =>
      db.insert(treeEdges).values({
        workflowTreeId: seed.treeId,
        sourceNodeId: seed.sourceNodeId,
        targetNodeId: seed.targetNodeId,
        priority: 1,
        auto: 1,
        guardDefinitionId: seed.guardDefinitionId,
      }).run(),
    ).toThrow();

    expect(() =>
      db.insert(treeEdges).values({
        workflowTreeId: seed.treeId,
        sourceNodeId: seed.sourceNodeId,
        targetNodeId: seed.targetNodeId,
        priority: 2,
        auto: 0,
      }).run(),
    ).toThrow();

    expect(() =>
      db.insert(treeEdges).values({
        workflowTreeId: seed.treeId,
        sourceNodeId: seed.sourceNodeId,
        targetNodeId: seed.targetNodeId,
        priority: 3,
        auto: 1,
      }).run(),
    ).not.toThrow();

    expect(() =>
      db.insert(treeEdges).values({
        workflowTreeId: seed.treeId,
        sourceNodeId: seed.sourceNodeId,
        targetNodeId: seed.targetNodeId,
        priority: 4,
        auto: 0,
        guardDefinitionId: seed.guardDefinitionId,
      }).run(),
    ).not.toThrow();
  });

  it('enforces run-node node_key consistency with referenced tree nodes', () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    const seed = seedTreeState(db);

    expect(() =>
      db.insert(runNodes).values({
        workflowRunId: seed.runId,
        treeNodeId: seed.sourceNodeId,
        nodeKey: 'mismatched_node_key',
        status: 'pending',
        sequenceIndex: 1,
      }).run(),
    ).toThrow('run_nodes.node_key must match tree_nodes.node_key for run_nodes.tree_node_id');

    const runNode = db
      .insert(runNodes)
      .values({
        workflowRunId: seed.runId,
        treeNodeId: seed.sourceNodeId,
        nodeKey: seed.sourceNodeKey,
        status: 'pending',
        sequenceIndex: 1,
      })
      .returning({ id: runNodes.id })
      .get();

    expect(() =>
      db.update(runNodes).set({ nodeKey: 'tampered_key' }).where(eq(runNodes.id, runNode.id)).run(),
    ).toThrow('run_nodes.node_key must match tree_nodes.node_key for run_nodes.tree_node_id');

    expect(() =>
      db
        .update(treeNodes)
        .set({ nodeKey: 'renamed_source_node' })
        .where(eq(treeNodes.id, seed.sourceNodeId))
        .run(),
    ).toThrow('tree_nodes.node_key cannot change while referenced by run_nodes');
  });

  it('rejects tree reassignment updates that would orphan edge and run-node tree invariants', () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);

    const first = seedTreeState(db, 'first');
    const second = seedTreeState(db, 'second');

    db.insert(treeEdges).values({
      workflowTreeId: first.treeId,
      sourceNodeId: first.sourceNodeId,
      targetNodeId: first.targetNodeId,
      priority: 1,
      auto: 0,
      guardDefinitionId: first.guardDefinitionId,
    }).run();

    db.insert(runNodes).values({
      workflowRunId: first.runId,
      treeNodeId: first.sourceNodeId,
      nodeKey: 'first_design',
      status: 'pending',
      sequenceIndex: 1,
    }).run();

    expect(() =>
      db.update(treeNodes).set({ workflowTreeId: second.treeId }).where(eq(treeNodes.id, first.sourceNodeId)).run(),
    ).toThrow();

    expect(() =>
      db.update(workflowRuns).set({ workflowTreeId: second.treeId }).where(eq(workflowRuns.id, first.runId)).run(),
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
      nodeKey: seed.sourceNodeKey,
      status: 'pending',
      sequenceIndex: 1,
    }).run();

    expect(() =>
      db.insert(runNodes).values({
        workflowRunId: seed.runId,
        treeNodeId: seed.targetNodeId,
        nodeKey: seed.targetNodeKey,
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
        nodeKey: seed.sourceNodeKey,
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
      db
        .update(runNodes)
        .set({ startedAt: '2026-01-01T00:00:00.000Z' })
        .where(eq(runNodes.id, runNode.id))
        .run(),
    ).toThrow();

    expect(() =>
      db.update(runNodes).set({ status: 'running', startedAt: null }).where(eq(runNodes.id, runNode.id)).run(),
    ).toThrow();
  });

  it('enforces initial run-node insert state at the DB layer', () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    const seed = seedTreeState(db);

    expect(() =>
      db.insert(runNodes).values({
        workflowRunId: seed.runId,
        treeNodeId: seed.sourceNodeId,
        nodeKey: seed.sourceNodeKey,
        status: 'running',
        startedAt: '2026-01-01T00:00:00.000Z',
        sequenceIndex: 1,
      }).run(),
    ).toThrow('run_nodes must be inserted in pending state with null started_at/completed_at');

    expect(() =>
      db.insert(runNodes).values({
        workflowRunId: seed.runId,
        treeNodeId: seed.sourceNodeId,
        nodeKey: seed.sourceNodeKey,
        status: 'completed',
        completedAt: '2026-01-01T00:00:00.000Z',
        sequenceIndex: 2,
      }).run(),
    ).toThrow('run_nodes must be inserted in pending state with null started_at/completed_at');
  });

  it('enforces run-node status transition graph on direct status updates', () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    const seed = seedTreeState(db);

    const runNode = db
      .insert(runNodes)
      .values({
        workflowRunId: seed.runId,
        treeNodeId: seed.sourceNodeId,
        nodeKey: seed.sourceNodeKey,
        status: 'pending',
        sequenceIndex: 1,
      })
      .returning({ id: runNodes.id })
      .get();

    expect(() =>
      db
        .update(runNodes)
        .set({ status: 'completed', completedAt: '2026-01-01T00:00:00.000Z' })
        .where(eq(runNodes.id, runNode.id))
        .run(),
    ).toThrow('run_nodes status transition is not allowed');

    expect(() =>
      db
        .update(runNodes)
        .set({ status: 'running', startedAt: '2026-01-01T00:00:00.000Z' })
        .where(eq(runNodes.id, runNode.id))
        .run(),
    ).not.toThrow();

    expect(() =>
      db
        .update(runNodes)
        .set({ status: 'completed', completedAt: '2026-01-01T00:01:00.000Z' })
        .where(eq(runNodes.id, runNode.id))
        .run(),
    ).not.toThrow();

    expect(() =>
      db
        .update(runNodes)
        .set({ status: 'running', startedAt: '2026-01-01T00:02:00.000Z', completedAt: null })
        .where(eq(runNodes.id, runNode.id))
        .run(),
    ).toThrow('run_nodes status transition is not allowed');
  });

  it('enforces run-node diagnostics attempt identity and bounds', () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    const seed = seedTreeState(db, 'diagnostics');

    const runNode = db
      .insert(runNodes)
      .values({
        workflowRunId: seed.runId,
        treeNodeId: seed.sourceNodeId,
        nodeKey: seed.sourceNodeKey,
        status: 'pending',
        sequenceIndex: 1,
      })
      .returning({ id: runNodes.id })
      .get();

    db.insert(runNodeDiagnostics)
      .values({
        workflowRunId: seed.runId,
        runNodeId: runNode.id,
        attempt: 1,
        outcome: 'completed',
        eventCount: 3,
        retainedEventCount: 3,
        droppedEventCount: 0,
        redacted: 0,
        truncated: 0,
        payloadChars: 128,
        diagnostics: { nodeKey: seed.sourceNodeKey },
      })
      .run();

    expect(() =>
      db.insert(runNodeDiagnostics)
        .values({
          workflowRunId: seed.runId,
          runNodeId: runNode.id,
          attempt: 1,
          outcome: 'completed',
          eventCount: 1,
          retainedEventCount: 1,
          droppedEventCount: 0,
          redacted: 0,
          truncated: 0,
          payloadChars: 16,
          diagnostics: { duplicate: true },
        })
        .run(),
    ).toThrow();

    expect(() =>
      db.insert(runNodeDiagnostics)
        .values({
          workflowRunId: seed.runId,
          runNodeId: runNode.id,
          attempt: 0,
          outcome: 'completed',
          eventCount: 1,
          retainedEventCount: 1,
          droppedEventCount: 0,
          redacted: 0,
          truncated: 0,
          payloadChars: 16,
          diagnostics: { invalid: true },
        })
        .run(),
    ).toThrow();
  });

  it('enforces run-node stream event attempt and sequence identity and bounds', () => {
    const db = createDatabase(':memory:');
    migrateDatabase(db);
    const seed = seedTreeState(db, 'stream-events');

    const runNode = db
      .insert(runNodes)
      .values({
        workflowRunId: seed.runId,
        treeNodeId: seed.sourceNodeId,
        nodeKey: seed.sourceNodeKey,
        status: 'pending',
        sequenceIndex: 1,
      })
      .returning({ id: runNodes.id })
      .get();

    db.insert(runNodeStreamEvents)
      .values({
        workflowRunId: seed.runId,
        runNodeId: runNode.id,
        attempt: 1,
        sequence: 1,
        eventType: 'system',
        timestamp: 100,
        contentChars: 5,
        contentPreview: 'start',
        metadata: { key: 'value' },
        usageDeltaTokens: null,
        usageCumulativeTokens: null,
      })
      .run();

    expect(() =>
      db.insert(runNodeStreamEvents)
        .values({
          workflowRunId: seed.runId,
          runNodeId: runNode.id,
          attempt: 1,
          sequence: 1,
          eventType: 'assistant',
          timestamp: 101,
          contentChars: 4,
          contentPreview: 'dup',
          metadata: null,
          usageDeltaTokens: null,
          usageCumulativeTokens: null,
        })
        .run(),
    ).toThrow();

    expect(() =>
      db.insert(runNodeStreamEvents)
        .values({
          workflowRunId: seed.runId,
          runNodeId: runNode.id,
          attempt: 0,
          sequence: 2,
          eventType: 'assistant',
          timestamp: 102,
          contentChars: 3,
          contentPreview: 'bad',
          metadata: null,
          usageDeltaTokens: null,
          usageCumulativeTokens: null,
        })
        .run(),
    ).toThrow();

    expect(() =>
      db.insert(runNodeStreamEvents)
        .values({
          workflowRunId: seed.runId,
          runNodeId: runNode.id,
          attempt: 1,
          sequence: 2,
          eventType: 'usage',
          timestamp: 103,
          contentChars: 0,
          contentPreview: '',
          metadata: { tokens: 10 },
          usageDeltaTokens: -1,
          usageCumulativeTokens: 10,
        })
        .run(),
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
    expect(names.has('run_nodes_node_key_idx')).toBe(true);
    expect(names.has('run_nodes_created_at_idx')).toBe(true);
    expect(names.has('tree_nodes_node_key_idx')).toBe(true);
    expect(names.has('repositories_name_uq')).toBe(true);
    expect(names.has('repositories_name_idx')).toBe(false);
    expect(names.has('repositories_created_at_idx')).toBe(true);
    expect(names.has('phase_artifacts_created_at_idx')).toBe(true);
    expect(names.has('routing_decisions_created_at_idx')).toBe(true);
    expect(names.has('run_node_diagnostics_run_id_run_node_attempt_uq')).toBe(true);
    expect(names.has('run_node_diagnostics_run_id_created_at_idx')).toBe(true);
    expect(names.has('run_node_diagnostics_run_node_id_created_at_idx')).toBe(true);
    expect(names.has('run_node_diagnostics_created_at_idx')).toBe(true);
    expect(names.has('run_node_stream_events_run_id_run_node_attempt_seq_uq')).toBe(true);
    expect(names.has('run_node_stream_events_run_id_attempt_sequence_idx')).toBe(true);
    expect(names.has('run_node_stream_events_run_id_created_at_idx')).toBe(true);
    expect(names.has('run_node_stream_events_run_node_id_created_at_idx')).toBe(true);
    expect(names.has('run_node_stream_events_created_at_idx')).toBe(true);
  });
});
