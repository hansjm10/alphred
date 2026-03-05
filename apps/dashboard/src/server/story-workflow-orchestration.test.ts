import { describe, expect, it, vi } from 'vitest';
import type { DashboardWorkItemSnapshot } from './dashboard-contracts';
import { DashboardIntegrationError } from './dashboard-errors';
import { runStoryWorkflowOrchestration, type StoryWorkflowOrchestrationOperations } from './story-workflow-orchestration';

function createWorkItem(overrides: Partial<DashboardWorkItemSnapshot> = {}): DashboardWorkItemSnapshot {
  return {
    id: overrides.id ?? 10,
    repositoryId: overrides.repositoryId ?? 1,
    type: overrides.type ?? 'story',
    status: overrides.status ?? 'Draft',
    title: overrides.title ?? 'Story title',
    description: overrides.description ?? null,
    parentId: overrides.parentId ?? null,
    tags: overrides.tags ?? null,
    plannedFiles: overrides.plannedFiles ?? null,
    assignees: overrides.assignees ?? null,
    priority: overrides.priority ?? null,
    estimate: overrides.estimate ?? null,
    revision: overrides.revision ?? 0,
    createdAt: overrides.createdAt ?? new Date('2026-03-05T00:00:00.000Z').toISOString(),
    updatedAt: overrides.updatedAt ?? new Date('2026-03-05T00:00:00.000Z').toISOString(),
    linkedWorkflowRun: overrides.linkedWorkflowRun ?? null,
    effectivePolicy: overrides.effectivePolicy ?? null,
  };
}

function createOperations(overrides: Partial<StoryWorkflowOrchestrationOperations> = {}): StoryWorkflowOrchestrationOperations {
  return {
    getWorkItem: vi.fn(),
    listWorkItems: vi.fn(),
    moveWorkItemStatus: vi.fn(),
    approveStoryBreakdown: vi.fn(),
    ...overrides,
  };
}

describe('runStoryWorkflowOrchestration', () => {
  it('approves and starts Ready tasks in approve-and-start mode', async () => {
    const story = createWorkItem({ id: 3, type: 'story', status: 'BreakdownProposed', revision: 4 });
    const approvedStory = createWorkItem({ id: 3, type: 'story', status: 'Approved', revision: 5 });
    const readyTaskA = createWorkItem({ id: 20, type: 'task', parentId: 3, status: 'Ready', revision: 1 });
    const readyTaskB = createWorkItem({ id: 21, type: 'task', parentId: 3, status: 'Ready', revision: 2 });
    const inProgressTaskA = createWorkItem({ ...readyTaskA, status: 'InProgress', revision: 2 });
    const inProgressTaskB = createWorkItem({ ...readyTaskB, status: 'InProgress', revision: 3 });

    const operations = createOperations({
      getWorkItem: vi.fn().mockResolvedValue({ workItem: story }),
      approveStoryBreakdown: vi.fn().mockResolvedValue({
        story: approvedStory,
        tasks: [readyTaskA, readyTaskB],
      }),
      moveWorkItemStatus: vi
        .fn()
        .mockResolvedValueOnce({ workItem: inProgressTaskA })
        .mockResolvedValueOnce({ workItem: inProgressTaskB }),
      listWorkItems: vi.fn().mockResolvedValue({ workItems: [] }),
    });

    const result = await runStoryWorkflowOrchestration({
      request: {
        repositoryId: 1,
        storyId: 3,
        expectedRevision: 4,
        actorType: 'human',
        actorLabel: 'alice',
        approveAndStart: true,
      },
      operations,
    });

    expect(result.story.status).toBe('Approved');
    expect(result.startedTasks.map(task => task.id)).toEqual([20, 21]);
    expect(result.steps).toEqual([
      expect.objectContaining({ step: 'move_to_needs_breakdown', outcome: 'skipped' }),
      expect.objectContaining({ step: 'generate_breakdown', outcome: 'skipped' }),
      expect.objectContaining({ step: 'approve_breakdown', outcome: 'applied' }),
      expect.objectContaining({ step: 'start_ready_tasks', outcome: 'applied', startedTaskIds: [20, 21] }),
    ]);
  });

  it('returns partial failure when some Ready tasks fail to start', async () => {
    const story = createWorkItem({ id: 3, type: 'story', status: 'Approved', revision: 2 });
    const readyTaskA = createWorkItem({ id: 20, type: 'task', parentId: 3, status: 'Ready', revision: 1 });
    const readyTaskB = createWorkItem({ id: 21, type: 'task', parentId: 3, status: 'Ready', revision: 7 });
    const inProgressTaskA = createWorkItem({ ...readyTaskA, status: 'InProgress', revision: 2 });

    const operations = createOperations({
      getWorkItem: vi.fn().mockResolvedValue({ workItem: story }),
      listWorkItems: vi.fn().mockResolvedValue({ workItems: [readyTaskA, readyTaskB] }),
      moveWorkItemStatus: vi
        .fn()
        .mockResolvedValueOnce({ workItem: inProgressTaskA })
        .mockRejectedValueOnce(
          new DashboardIntegrationError('conflict', 'Task revision conflict.', { status: 409 }),
        ),
    });

    const result = await runStoryWorkflowOrchestration({
      request: {
        repositoryId: 1,
        storyId: 3,
        expectedRevision: 2,
        actorType: 'human',
        actorLabel: 'alice',
      },
      operations,
    });

    expect(result.startedTasks.map(task => task.id)).toEqual([20]);
    expect(result.steps.at(-1)).toEqual(
      expect.objectContaining({
        step: 'start_ready_tasks',
        outcome: 'partial_failure',
        startedTaskIds: [20],
        failedTaskIds: [21],
      }),
    );
  });

  it('rethrows non-conflict task start failures', async () => {
    const story = createWorkItem({ id: 3, type: 'story', status: 'Approved', revision: 2 });
    const readyTask = createWorkItem({ id: 20, type: 'task', parentId: 3, status: 'Ready', revision: 1 });

    const operations = createOperations({
      getWorkItem: vi.fn().mockResolvedValue({ workItem: story }),
      listWorkItems: vi.fn().mockResolvedValue({ workItems: [readyTask] }),
      moveWorkItemStatus: vi
        .fn()
        .mockRejectedValueOnce(new DashboardIntegrationError('internal_error', 'Task launch failed.', { status: 500 })),
    });

    await expect(
      runStoryWorkflowOrchestration({
        request: {
          repositoryId: 1,
          storyId: 3,
          expectedRevision: 2,
          actorType: 'human',
          actorLabel: 'alice',
        },
        operations,
      }),
    ).rejects.toMatchObject({
      code: 'internal_error',
      status: 500,
      message: 'Task launch failed.',
    });
  });

  it('throws a revision conflict before mutating when story revision mismatches expectedRevision', async () => {
    const operations = createOperations({
      getWorkItem: vi.fn().mockResolvedValue({
        workItem: createWorkItem({ id: 3, type: 'story', status: 'Draft', revision: 9 }),
      }),
    });

    await expect(
      runStoryWorkflowOrchestration({
        request: {
          repositoryId: 1,
          storyId: 3,
          expectedRevision: 2,
          actorType: 'human',
          actorLabel: 'alice',
        },
        operations,
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
    });
    expect(operations.moveWorkItemStatus).not.toHaveBeenCalled();
    expect(operations.approveStoryBreakdown).not.toHaveBeenCalled();
  });

  it('returns blocked generation step in generate-only mode when story reaches NeedsBreakdown', async () => {
    const draftStory = createWorkItem({ id: 3, type: 'story', status: 'Draft', revision: 0 });
    const needsBreakdownStory = createWorkItem({ id: 3, type: 'story', status: 'NeedsBreakdown', revision: 1 });

    const operations = createOperations({
      getWorkItem: vi.fn().mockResolvedValue({ workItem: draftStory }),
      moveWorkItemStatus: vi.fn().mockResolvedValue({ workItem: needsBreakdownStory }),
    });

    const result = await runStoryWorkflowOrchestration({
      request: {
        repositoryId: 1,
        storyId: 3,
        expectedRevision: 0,
        actorType: 'human',
        actorLabel: 'alice',
        generateOnly: true,
      },
      operations,
    });

    expect(result.story.status).toBe('NeedsBreakdown');
    expect(result.steps).toEqual([
      expect.objectContaining({ step: 'move_to_needs_breakdown', outcome: 'applied' }),
      expect.objectContaining({ step: 'generate_breakdown', outcome: 'blocked' }),
      expect.objectContaining({ step: 'approve_breakdown', outcome: 'skipped' }),
      expect.objectContaining({ step: 'start_ready_tasks', outcome: 'skipped' }),
    ]);
  });
});
