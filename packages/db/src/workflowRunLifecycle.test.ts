import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDatabase } from './connection.js';
import { migrateDatabase } from './migrate.js';
import { workflowRuns, workflowTrees } from './schema.js';
import { assertValidWorkflowRunTransition, transitionWorkflowRunStatus } from './workflowRunLifecycle.js';

function seedPendingWorkflowRun() {
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

  const run = db
    .insert(workflowRuns)
    .values({
      workflowTreeId: tree.id,
      status: 'pending',
    })
    .returning({ id: workflowRuns.id })
    .get();

  return { db, workflowRunId: run.id };
}

describe('workflow-run lifecycle guard', () => {
  it('allows only configured workflow-run status transitions', () => {
    expect(() => assertValidWorkflowRunTransition('pending', 'running')).not.toThrow();
    expect(() => assertValidWorkflowRunTransition('running', 'completed')).not.toThrow();
    expect(() => assertValidWorkflowRunTransition('running', 'paused')).not.toThrow();
    expect(() => assertValidWorkflowRunTransition('paused', 'running')).not.toThrow();
    expect(() => assertValidWorkflowRunTransition('pending', 'failed')).toThrow();
    expect(() => assertValidWorkflowRunTransition('completed', 'running')).toThrow();
  });

  it('persists valid transitions with optimistic state preconditions', () => {
    const { db, workflowRunId } = seedPendingWorkflowRun();

    transitionWorkflowRunStatus(db, {
      workflowRunId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:00:00.000Z',
    });

    let persisted = db
      .select({
        status: workflowRuns.status,
        startedAt: workflowRuns.startedAt,
        completedAt: workflowRuns.completedAt,
      })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, workflowRunId))
      .get();

    expect(persisted).toBeDefined();
    if (!persisted) {
      throw new Error('Expected workflow run row after running transition.');
    }

    expect(persisted.status).toBe('running');
    expect(persisted.startedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(persisted.completedAt).toBeNull();

    transitionWorkflowRunStatus(db, {
      workflowRunId,
      expectedFrom: 'running',
      to: 'paused',
      occurredAt: '2026-01-01T00:01:00.000Z',
    });

    transitionWorkflowRunStatus(db, {
      workflowRunId,
      expectedFrom: 'paused',
      to: 'running',
      occurredAt: '2026-01-01T00:02:00.000Z',
    });

    transitionWorkflowRunStatus(db, {
      workflowRunId,
      expectedFrom: 'running',
      to: 'completed',
      occurredAt: '2026-01-01T00:03:00.000Z',
    });

    persisted = db
      .select({
        status: workflowRuns.status,
        startedAt: workflowRuns.startedAt,
        completedAt: workflowRuns.completedAt,
      })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, workflowRunId))
      .get();

    expect(persisted).toBeDefined();
    if (!persisted) {
      throw new Error('Expected workflow run row after completed transition.');
    }

    expect(persisted.status).toBe('completed');
    expect(persisted.startedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(persisted.completedAt).toBe('2026-01-01T00:03:00.000Z');
  });

  it('rejects invalid transitions and stale expected states', () => {
    const { db, workflowRunId } = seedPendingWorkflowRun();

    expect(() =>
      transitionWorkflowRunStatus(db, {
        workflowRunId,
        expectedFrom: 'pending',
        to: 'failed',
      }),
    ).toThrow('Invalid workflow-run status transition');

    transitionWorkflowRunStatus(db, {
      workflowRunId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-01-01T00:00:00.000Z',
    });

    expect(() =>
      transitionWorkflowRunStatus(db, {
        workflowRunId,
        expectedFrom: 'pending',
        to: 'cancelled',
      }),
    ).toThrow('Workflow-run transition precondition failed');
  });
});
