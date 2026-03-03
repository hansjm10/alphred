import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DashboardWorkItemSnapshot } from '@dashboard/server/dashboard-contracts';
import {
  applyBoardEventToWorkItems,
  fetchWorkItem,
  moveWorkItemStatus,
  parseBoardEventSnapshot,
  requestWorkItemReplan,
  toWorkItemsById,
  type BoardEventSnapshot,
  type WorkItemActor,
} from './work-items-shared';

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
    createdAt: overrides.createdAt ?? new Date('2026-03-02T00:00:00.000Z').toISOString(),
    updatedAt: overrides.updatedAt ?? new Date('2026-03-02T00:00:00.000Z').toISOString(),
    effectivePolicy: overrides.effectivePolicy ?? null,
  };
}

function createEvent(overrides: Partial<BoardEventSnapshot> = {}): BoardEventSnapshot {
  return {
    id: overrides.id ?? 99,
    repositoryId: overrides.repositoryId ?? 1,
    workItemId: overrides.workItemId ?? 10,
    eventType: overrides.eventType ?? 'created',
    payload: overrides.payload ?? null,
    createdAt: overrides.createdAt ?? new Date('2026-03-02T00:00:00.000Z').toISOString(),
  };
}

const actor: WorkItemActor = { actorType: 'human', actorLabel: 'octocat' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseBoardEventSnapshot', () => {
  it('returns null for malformed payloads', () => {
    expect(parseBoardEventSnapshot(null)).toBeNull();
    expect(parseBoardEventSnapshot({})).toBeNull();
    expect(parseBoardEventSnapshot({ id: 1 })).toBeNull();
    expect(
      parseBoardEventSnapshot({
        id: 1,
        repositoryId: 1,
        workItemId: 2,
        eventType: 'created',
        createdAt: '2026-03-02T00:00:00.000Z',
      }),
    ).not.toBeNull();
  });
});

describe('applyBoardEventToWorkItems', () => {
  it('applies created/updated/status changes and ignores other repositories', () => {
    const createdPolicy = {
      appliesToType: 'task' as const,
      epicWorkItemId: 101,
      repositoryPolicyId: 5,
      epicPolicyId: 9,
      policy: {
        allowedProviders: ['codex'],
        allowedModels: ['gpt-5-codex'],
        allowedSkillIdentifiers: ['working-on-github-issue'],
        allowedMcpServerIdentifiers: ['github'],
        budgets: {
          maxConcurrentTasks: 3,
          maxConcurrentRuns: 2,
        },
        requiredGates: {
          breakdownApprovalRequired: false,
        },
      },
    };
    const reparentedPolicy = {
      ...createdPolicy,
      epicWorkItemId: 202,
      epicPolicyId: 10,
    };
    const previous = toWorkItemsById([
      createWorkItem({
        id: 10,
        repositoryId: 1,
        title: 'Old',
        revision: 1,
        effectivePolicy: createdPolicy,
      }),
    ]);

    const created = applyBoardEventToWorkItems(
      previous,
      1,
      createEvent({
        workItemId: 20,
        eventType: 'created',
        payload: { type: 'task', status: 'Draft', title: 'Task A', revision: 1, effectivePolicy: createdPolicy },
      }),
    );
    expect(created[20]?.title).toBe('Task A');
    expect(created[20]?.effectivePolicy).toEqual(createdPolicy);

    const updated = applyBoardEventToWorkItems(
      created,
      1,
      createEvent({
        workItemId: 10,
        eventType: 'updated',
        payload: { revision: 2, changes: { title: 'New title', description: 'Updated' } },
      }),
    );
    expect(updated[10]?.title).toBe('New title');
    expect(updated[10]?.description).toBe('Updated');
    expect(updated[10]?.revision).toBe(2);

    const statusChanged = applyBoardEventToWorkItems(
      updated,
      1,
      createEvent({
        workItemId: 10,
        eventType: 'status_changed',
        payload: {
          toStatus: 'Approved',
          revision: 3,
          linkedWorkflowRun: {
            workflowRunId: 88,
            runStatus: 'running',
            linkedAt: '2026-03-03T00:00:00.000Z',
            touchedFiles: ['src/a.ts'],
          },
        },
      }),
    );
    expect(statusChanged[10]?.status).toBe('Approved');
    expect(statusChanged[10]?.revision).toBe(3);
    expect(statusChanged[10]?.linkedWorkflowRun).toEqual({
      workflowRunId: 88,
      runStatus: 'running',
      linkedAt: '2026-03-03T00:00:00.000Z',
      touchedFiles: ['src/a.ts'],
    });

    const statusChangedWithoutTouchedFiles = applyBoardEventToWorkItems(
      statusChanged,
      1,
      createEvent({
        workItemId: 10,
        eventType: 'status_changed',
        payload: {
          toStatus: 'InReview',
          revision: 4,
          linkedWorkflowRun: {
            workflowRunId: 88,
            runStatus: 'running',
            linkedAt: '2026-03-03T00:01:00.000Z',
          },
        },
      }),
    );
    expect(statusChangedWithoutTouchedFiles[10]?.linkedWorkflowRun).toEqual({
      workflowRunId: 88,
      runStatus: 'running',
      linkedAt: '2026-03-03T00:01:00.000Z',
    });

    const breakdownProposed = applyBoardEventToWorkItems(
      statusChangedWithoutTouchedFiles,
      1,
      createEvent({
        workItemId: 10,
        eventType: 'breakdown_proposed',
        payload: { toStatus: 'BreakdownProposed', revision: 5 },
      }),
    );
    expect(breakdownProposed[10]?.status).toBe('BreakdownProposed');
    expect(breakdownProposed[10]?.revision).toBe(5);

    const reparented = applyBoardEventToWorkItems(
      breakdownProposed,
      1,
      createEvent({
        workItemId: 10,
        eventType: 'reparented',
        payload: { toParentId: 200, revision: 6, effectivePolicy: reparentedPolicy },
      }),
    );
    expect(reparented[10]?.parentId).toBe(200);
    expect(reparented[10]?.revision).toBe(6);
    expect(reparented[10]?.effectivePolicy).toEqual(reparentedPolicy);

    const ignored = applyBoardEventToWorkItems(
      reparented,
      2,
      createEvent({
        repositoryId: 1,
        workItemId: 10,
        eventType: 'status_changed',
        payload: { toStatus: 'Cancelled', revision: 5 },
      }),
    );
    expect(ignored[10]?.status).toBe('BreakdownProposed');
  });

  it('ignores malformed effectivePolicy payloads for created and reparented events', () => {
    const validPolicy = {
      appliesToType: 'task' as const,
      epicWorkItemId: 101,
      repositoryPolicyId: 5,
      epicPolicyId: 9,
      policy: {
        allowedProviders: ['codex'],
        allowedModels: ['gpt-5-codex'],
        allowedSkillIdentifiers: ['working-on-github-issue'],
        allowedMcpServerIdentifiers: ['github'],
        budgets: {
          maxConcurrentTasks: 3,
          maxConcurrentRuns: 2,
        },
        requiredGates: {
          breakdownApprovalRequired: false,
        },
      },
    };
    const previous = toWorkItemsById([
      createWorkItem({
        id: 10,
        repositoryId: 1,
        title: 'Existing',
        revision: 1,
        effectivePolicy: validPolicy,
      }),
    ]);

    const malformedCreated = applyBoardEventToWorkItems(
      previous,
      1,
      createEvent({
        workItemId: 20,
        eventType: 'created',
        payload: { type: 'task', status: 'Draft', title: 'Task B', revision: 1, effectivePolicy: {} },
      }),
    );
    expect(malformedCreated[20]?.effectivePolicy).toBeNull();

    const malformedReparented = applyBoardEventToWorkItems(
      previous,
      1,
      createEvent({
        workItemId: 10,
        eventType: 'reparented',
        payload: { toParentId: 200, revision: 2, effectivePolicy: {} },
      }),
    );
    expect(malformedReparented[10]?.effectivePolicy).toEqual(validPolicy);
  });
});

describe('fetchWorkItem', () => {
  it('returns the snapshot when the API responds OK', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ workItem: createWorkItem({ id: 3, title: 'Loaded' }) }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const workItem = await fetchWorkItem({ repositoryId: 1, workItemId: 3 });
    expect(workItem.title).toBe('Loaded');
  });

  it('throws with the server error message when the API fails', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'Nope' } }), { status: 500 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchWorkItem({ repositoryId: 1, workItemId: 3 })).rejects.toThrow('Nope');
  });

  it('throws for malformed responses', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchWorkItem({ repositoryId: 1, workItemId: 3 })).rejects.toThrow(
      'Unable to refresh work item (malformed response).',
    );
  });
});

describe('moveWorkItemStatus', () => {
  it('returns ok=true for successful responses', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ workItem: createWorkItem({ id: 3, status: 'NeedsBreakdown', revision: 2 }) }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await moveWorkItemStatus({
      repositoryId: 1,
      workItemId: 3,
      expectedRevision: 1,
      toStatus: 'NeedsBreakdown',
      actor,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.workItem.status).toBe('NeedsBreakdown');
    }
  });

  it('returns ok=false with the configured errorPrefix', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 409 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await moveWorkItemStatus({
      repositoryId: 1,
      workItemId: 3,
      expectedRevision: 1,
      toStatus: 'NeedsBreakdown',
      actor,
      errorPrefix: 'Unable to move story status',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe('Unable to move story status (HTTP 409).');
    }
  });

  it('returns ok=false for malformed responses', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await moveWorkItemStatus({
      repositoryId: 1,
      workItemId: 3,
      expectedRevision: 1,
      toStatus: 'NeedsBreakdown',
      actor,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe('Unable to move work item (malformed response).');
    }
  });
});

describe('requestWorkItemReplan', () => {
  it('returns ok=true for successful responses', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          repositoryId: 1,
          workItemId: 3,
          workflowRunId: 12,
          eventId: 40,
          requestedAt: '2026-03-03T00:00:00.000Z',
          plannedButUntouched: ['src/planned.ts'],
          touchedButUnplanned: ['src/actual.ts'],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await requestWorkItemReplan({
      repositoryId: 1,
      workItemId: 3,
      actor,
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/dashboard/repositories/1/work-items/3/actions/request-replan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actorType: 'human',
        actorLabel: 'octocat',
      }),
    });
    expect(result).toEqual({
      ok: true,
      result: {
        repositoryId: 1,
        workItemId: 3,
        workflowRunId: 12,
        eventId: 40,
        requestedAt: '2026-03-03T00:00:00.000Z',
        plannedButUntouched: ['src/planned.ts'],
        touchedButUnplanned: ['src/actual.ts'],
      },
    });
  });

  it('returns ok=false with API error responses', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'Conflict' } }), { status: 409 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await requestWorkItemReplan({
      repositoryId: 1,
      workItemId: 3,
      actor,
    });

    expect(result).toEqual({
      ok: false,
      status: 409,
      message: 'Conflict',
    });
  });

  it('returns ok=false for malformed success payloads', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ repositoryId: 1 }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await requestWorkItemReplan({
      repositoryId: 1,
      workItemId: 3,
      actor,
    });

    expect(result).toEqual({
      ok: false,
      status: 500,
      message: 'Unable to request replanning (malformed response).',
    });
  });
});
