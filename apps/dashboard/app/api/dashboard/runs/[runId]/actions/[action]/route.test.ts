import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardIntegrationError } from '@dashboard/server/dashboard-errors';

const { createDashboardServiceMock, controlWorkflowRunMock, cleanupRunWorktreeMock } = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  controlWorkflowRunMock: vi.fn(),
  cleanupRunWorktreeMock: vi.fn(),
}));

vi.mock('@dashboard/server/dashboard-service', () => ({
  createDashboardService: createDashboardServiceMock,
}));

import { POST } from './route';

describe('POST /api/dashboard/runs/[runId]/actions/[action]', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    controlWorkflowRunMock.mockReset();
    cleanupRunWorktreeMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      controlWorkflowRun: controlWorkflowRunMock,
      cleanupRunWorktree: cleanupRunWorktreeMock,
    });
  });

  it('controls a run lifecycle action for a valid run id and action', async () => {
    controlWorkflowRunMock.mockResolvedValue({
      action: 'pause',
      outcome: 'applied',
      workflowRunId: 11,
      previousRunStatus: 'running',
      runStatus: 'paused',
      retriedRunNodeIds: [],
    });

    const response = await POST(new Request('http://localhost/api/dashboard/runs/11/actions/pause', { method: 'POST' }), {
      params: Promise.resolve({ runId: '11', action: 'pause' }),
    });

    expect(controlWorkflowRunMock).toHaveBeenCalledWith(11, 'pause');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      action: 'pause',
      outcome: 'applied',
      workflowRunId: 11,
      previousRunStatus: 'running',
      runStatus: 'paused',
      retriedRunNodeIds: [],
    });
  });

  it('returns 400 when runId is invalid', async () => {
    const response = await POST(new Request('http://localhost/api/dashboard/runs/invalid/actions/pause', { method: 'POST' }), {
      params: Promise.resolve({ runId: 'invalid', action: 'pause' }),
    });

    expect(controlWorkflowRunMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'runId must be a positive integer.',
      },
    });
  });

  it('returns 400 when action is unsupported', async () => {
    const response = await POST(new Request('http://localhost/api/dashboard/runs/11/actions/start', { method: 'POST' }), {
      params: Promise.resolve({ runId: '11', action: 'start' }),
    });

    expect(controlWorkflowRunMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'action must be one of: cancel, pause, resume, retry, cleanup-worktree.',
      },
    });
  });

  it('runs cleanup-worktree action for a terminal run and returns updated worktrees', async () => {
    cleanupRunWorktreeMock.mockResolvedValue({
      worktrees: [
        {
          id: 21,
          runId: 11,
          repositoryId: 7,
          path: '/tmp/worktrees/demo-run-11',
          branch: 'alphred/demo-tree/11',
          commitHash: 'abc1234',
          status: 'removed',
          createdAt: '2026-03-04T18:22:00.000Z',
          removedAt: '2026-03-04T18:25:00.000Z',
        },
      ],
    });

    const response = await POST(
      new Request('http://localhost/api/dashboard/runs/11/actions/cleanup-worktree', { method: 'POST' }),
      {
        params: Promise.resolve({ runId: '11', action: 'cleanup-worktree' }),
      },
    );

    expect(cleanupRunWorktreeMock).toHaveBeenCalledWith(11);
    expect(controlWorkflowRunMock).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      worktrees: [
        {
          id: 21,
          runId: 11,
          repositoryId: 7,
          path: '/tmp/worktrees/demo-run-11',
          branch: 'alphred/demo-tree/11',
          commitHash: 'abc1234',
          status: 'removed',
          createdAt: '2026-03-04T18:22:00.000Z',
          removedAt: '2026-03-04T18:25:00.000Z',
        },
      ],
    });
  });

  it('returns deterministic conflict envelope when cleanup-worktree is blocked for a non-terminal run', async () => {
    cleanupRunWorktreeMock.mockRejectedValue(
      new DashboardIntegrationError(
        'conflict',
        'Workflow run id=11 must be terminal before worktree cleanup; current status is "running".',
        {
          status: 409,
          details: {
            workflowRunId: 11,
            runStatus: 'running',
            allowedRunStatuses: ['completed', 'failed', 'cancelled'],
          },
        },
      ),
    );

    const response = await POST(
      new Request('http://localhost/api/dashboard/runs/11/actions/cleanup-worktree', { method: 'POST' }),
      {
        params: Promise.resolve({ runId: '11', action: 'cleanup-worktree' }),
      },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'conflict',
        message: 'Workflow run id=11 must be terminal before worktree cleanup; current status is "running".',
        details: {
          workflowRunId: 11,
          runStatus: 'running',
          allowedRunStatuses: ['completed', 'failed', 'cancelled'],
        },
      },
    });
  });

  it('returns 200 for cleanup-worktree idempotent no-op responses', async () => {
    cleanupRunWorktreeMock.mockResolvedValue({
      worktrees: [
        {
          id: 21,
          runId: 11,
          repositoryId: 7,
          path: '/tmp/worktrees/demo-run-11',
          branch: 'alphred/demo-tree/11',
          commitHash: 'abc1234',
          status: 'removed',
          createdAt: '2026-03-04T18:22:00.000Z',
          removedAt: '2026-03-04T18:23:00.000Z',
        },
      ],
    });

    const response = await POST(
      new Request('http://localhost/api/dashboard/runs/11/actions/cleanup-worktree', { method: 'POST' }),
      {
        params: Promise.resolve({ runId: '11', action: 'cleanup-worktree' }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      worktrees: [
        {
          id: 21,
          runId: 11,
          repositoryId: 7,
          path: '/tmp/worktrees/demo-run-11',
          branch: 'alphred/demo-tree/11',
          commitHash: 'abc1234',
          status: 'removed',
          createdAt: '2026-03-04T18:22:00.000Z',
          removedAt: '2026-03-04T18:23:00.000Z',
        },
      ],
    });
  });

  it('maps service failures to integration error responses', async () => {
    controlWorkflowRunMock.mockRejectedValue(new Error('control failed'));

    const response = await POST(new Request('http://localhost/api/dashboard/runs/11/actions/cancel', { method: 'POST' }), {
      params: Promise.resolve({ runId: '11', action: 'cancel' }),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'internal_error',
        message: 'Dashboard integration request failed.',
        details: {
          cause: 'control failed',
        },
      },
    });
  });
});
