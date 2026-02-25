import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDatabase } from './connection.js';
import { migrateDatabase } from './migrate.js';
import {
  promptTemplates,
  runNodes,
  treeNodes,
  workflowRuns,
  workflowTrees,
} from './schema.js';
import { assertValidRunNodeTransition, transitionRunNodeStatus } from './runNodeLifecycle.js';
import { transitionWorkflowRunStatus } from './workflowRunLifecycle.js';

function seedPendingRunNode() {
  const db = createDatabase(':memory:');
  migrateDatabase(db);

  const tree = db
    .insert(workflowTrees)
    .values({
      treeKey: 'design_tree',
      version: 1,
      name: 'Design tree',
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

  const node = db
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

  const run = db
    .insert(workflowRuns)
    .values({
      workflowTreeId: tree.id,
      status: 'pending',
    })
    .returning({ id: workflowRuns.id })
    .get();

  const runNode = db
    .insert(runNodes)
    .values({
      workflowRunId: run.id,
      treeNodeId: node.id,
      nodeKey: 'design',
      status: 'pending',
      sequenceIndex: 1,
    })
    .returning({ id: runNodes.id })
    .get();

  return { db, runId: run.id, runNodeId: runNode.id };
}

describe('run-node lifecycle guard', () => {
  it('allows only configured run-node status transitions', () => {
    expect(() => assertValidRunNodeTransition('pending', 'running')).not.toThrow();
    expect(() => assertValidRunNodeTransition('running', 'completed')).not.toThrow();
    expect(() => assertValidRunNodeTransition('completed', 'pending')).not.toThrow();
    expect(() => assertValidRunNodeTransition('failed', 'running')).not.toThrow();
    expect(() => assertValidRunNodeTransition('failed', 'pending')).not.toThrow();
    expect(() => assertValidRunNodeTransition('skipped', 'pending')).not.toThrow();
    expect(() => assertValidRunNodeTransition('completed', 'running')).toThrow();
    expect(() => assertValidRunNodeTransition('pending', 'completed')).toThrow();
  });

  it('persists valid transitions with optimistic state preconditions', () => {
    const { db, runNodeId } = seedPendingRunNode();

    transitionRunNodeStatus(db, {
      runNodeId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:00:00.000Z',
    });

    let persisted = db
      .select({
        status: runNodes.status,
        startedAt: runNodes.startedAt,
        completedAt: runNodes.completedAt,
      })
      .from(runNodes)
      .where(eq(runNodes.id, runNodeId))
      .get();

    expect(persisted).toBeDefined();
    if (!persisted) {
      throw new Error('Expected run-node row to exist after running transition');
    }

    expect(persisted.status).toBe('running');
    expect(persisted.startedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(persisted.completedAt).toBeNull();

    transitionRunNodeStatus(db, {
      runNodeId,
      expectedFrom: 'running',
      to: 'failed',
      occurredAt: '2026-01-01T00:01:00.000Z',
    });

    persisted = db
      .select({
        status: runNodes.status,
        startedAt: runNodes.startedAt,
        completedAt: runNodes.completedAt,
      })
      .from(runNodes)
      .where(eq(runNodes.id, runNodeId))
      .get();

    expect(persisted).toBeDefined();
    if (!persisted) {
      throw new Error('Expected run-node row to exist after failed transition');
    }

    expect(persisted.status).toBe('failed');
    expect(persisted.completedAt).toBe('2026-01-01T00:01:00.000Z');

    transitionRunNodeStatus(db, {
      runNodeId,
      expectedFrom: 'failed',
      to: 'running',
      occurredAt: '2026-01-01T00:02:00.000Z',
    });

    persisted = db
      .select({
        status: runNodes.status,
        startedAt: runNodes.startedAt,
        completedAt: runNodes.completedAt,
      })
      .from(runNodes)
      .where(eq(runNodes.id, runNodeId))
      .get();

    expect(persisted).toBeDefined();
    if (!persisted) {
      throw new Error('Expected run-node row to exist after retry transition');
    }

    expect(persisted.status).toBe('running');
    expect(persisted.startedAt).toBe('2026-01-01T00:02:00.000Z');
    expect(persisted.completedAt).toBeNull();

    transitionRunNodeStatus(db, {
      runNodeId,
      expectedFrom: 'running',
      to: 'failed',
      occurredAt: '2026-01-01T00:02:30.000Z',
    });

    transitionRunNodeStatus(db, {
      runNodeId,
      expectedFrom: 'failed',
      to: 'pending',
      occurredAt: '2026-01-01T00:03:00.000Z',
    });

    persisted = db
      .select({
        status: runNodes.status,
        startedAt: runNodes.startedAt,
        completedAt: runNodes.completedAt,
      })
      .from(runNodes)
      .where(eq(runNodes.id, runNodeId))
      .get();

    expect(persisted).toBeDefined();
    if (!persisted) {
      throw new Error('Expected run-node row to exist after failed->pending retry-queue transition');
    }

    expect(persisted.status).toBe('pending');
    expect(persisted.startedAt).toBeNull();
    expect(persisted.completedAt).toBeNull();

    transitionRunNodeStatus(db, {
      runNodeId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:03:30.000Z',
    });

    transitionRunNodeStatus(db, {
      runNodeId,
      expectedFrom: 'running',
      to: 'completed',
      occurredAt: '2026-01-01T00:04:00.000Z',
    });

    transitionRunNodeStatus(db, {
      runNodeId,
      expectedFrom: 'completed',
      to: 'pending',
      occurredAt: '2026-01-01T00:05:00.000Z',
    });

    persisted = db
      .select({
        status: runNodes.status,
        startedAt: runNodes.startedAt,
        completedAt: runNodes.completedAt,
      })
      .from(runNodes)
      .where(eq(runNodes.id, runNodeId))
      .get();

    expect(persisted).toBeDefined();
    if (!persisted) {
      throw new Error('Expected run-node row to exist after requeue transition');
    }

    expect(persisted.status).toBe('pending');
    expect(persisted.startedAt).toBeNull();
    expect(persisted.completedAt).toBeNull();
  });

  it('rejects invalid transitions and stale expected states', () => {
    const { db, runNodeId } = seedPendingRunNode();

    expect(() =>
      transitionRunNodeStatus(db, {
        runNodeId,
        expectedFrom: 'pending',
        to: 'completed',
      }),
    ).toThrow('Invalid run-node status transition');

    transitionRunNodeStatus(db, {
      runNodeId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:00:00.000Z',
    });

    expect(() =>
      transitionRunNodeStatus(db, {
        runNodeId,
        expectedFrom: 'pending',
        to: 'skipped',
      }),
    ).toThrow('Run-node transition precondition failed');
  });

  it('supports run-status preconditions for guarded claim transitions', () => {
    const { db, runId, runNodeId } = seedPendingRunNode();

    transitionRunNodeStatus(db, {
      runNodeId,
      expectedFrom: 'pending',
      to: 'running',
      workflowRunId: runId,
      requiredRunStatuses: ['pending', 'running'],
      occurredAt: '2026-01-01T00:00:00.000Z',
    });

    const persisted = db
      .select({
        status: runNodes.status,
      })
      .from(runNodes)
      .where(eq(runNodes.id, runNodeId))
      .get();
    expect(persisted?.status).toBe('running');
  });

  it('requires workflowRunId when required run statuses are provided', () => {
    const { db, runNodeId } = seedPendingRunNode();

    expect(() =>
      transitionRunNodeStatus(db, {
        runNodeId,
        expectedFrom: 'pending',
        to: 'running',
        requiredRunStatuses: ['pending', 'running'],
      }),
    ).toThrow('workflowRunId must be provided when requiredRunStatuses is set.');
  });

  it('rejects guarded claim transitions when run status no longer matches required statuses', () => {
    const { db, runId, runNodeId } = seedPendingRunNode();
    transitionWorkflowRunStatus(db, {
      workflowRunId: runId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    transitionWorkflowRunStatus(db, {
      workflowRunId: runId,
      expectedFrom: 'running',
      to: 'paused',
      occurredAt: '2026-01-01T00:01:00.000Z',
    });

    expect(() =>
      transitionRunNodeStatus(db, {
        runNodeId,
        expectedFrom: 'pending',
        to: 'running',
        workflowRunId: runId,
        requiredRunStatuses: ['pending', 'running'],
      }),
    ).toThrow('Run-node transition precondition failed');
  });
});
