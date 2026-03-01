import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createDashboardServiceMock, getRunNodeDiagnosticCommandOutputMock } = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  getRunNodeDiagnosticCommandOutputMock: vi.fn(),
}));

vi.mock('../../../../../../../../../../../src/server/dashboard-service', () => ({
  createDashboardService: createDashboardServiceMock,
}));

import { GET } from './route';

describe('GET /api/dashboard/runs/[runId]/nodes/[runNodeId]/diagnostics/[attempt]/commands/[eventIndex]', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    getRunNodeDiagnosticCommandOutputMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      getRunNodeDiagnosticCommandOutput: getRunNodeDiagnosticCommandOutputMock,
    });
  });

  it('returns failed command output for valid path params', async () => {
    getRunNodeDiagnosticCommandOutputMock.mockResolvedValue({
      workflowRunId: 11,
      runNodeId: 4,
      attempt: 2,
      eventIndex: 8,
      sequence: 9,
      artifactId: 101,
      command: 'pnpm test:e2e',
      exitCode: 1,
      outputChars: 42,
      output: 'full stderr output',
      stdout: null,
      stderr: 'full stderr output',
      createdAt: '2026-02-18T00:00:00.000Z',
    });

    const response = await GET(
      new Request('http://localhost/api/dashboard/runs/11/nodes/4/diagnostics/2/commands/8'),
      {
        params: Promise.resolve({
          runId: '11',
          runNodeId: '4',
          attempt: '2',
          eventIndex: '8',
        }),
      },
    );

    expect(getRunNodeDiagnosticCommandOutputMock).toHaveBeenCalledWith({
      runId: 11,
      runNodeId: 4,
      attempt: 2,
      eventIndex: 8,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      workflowRunId: 11,
      runNodeId: 4,
      attempt: 2,
      eventIndex: 8,
      sequence: 9,
      artifactId: 101,
      command: 'pnpm test:e2e',
      exitCode: 1,
      outputChars: 42,
      output: 'full stderr output',
      stdout: null,
      stderr: 'full stderr output',
      createdAt: '2026-02-18T00:00:00.000Z',
    });
  });

  it('returns 400 when eventIndex is invalid', async () => {
    const response = await GET(
      new Request('http://localhost/api/dashboard/runs/11/nodes/4/diagnostics/2/commands/not-a-number'),
      {
        params: Promise.resolve({
          runId: '11',
          runNodeId: '4',
          attempt: '2',
          eventIndex: 'not-a-number',
        }),
      },
    );

    expect(getRunNodeDiagnosticCommandOutputMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'eventIndex must be a non-negative integer.',
      },
    });
  });

  it('maps service failures to integration error responses', async () => {
    getRunNodeDiagnosticCommandOutputMock.mockRejectedValue(new Error('lookup failed'));

    const response = await GET(
      new Request('http://localhost/api/dashboard/runs/11/nodes/4/diagnostics/2/commands/8'),
      {
        params: Promise.resolve({
          runId: '11',
          runNodeId: '4',
          attempt: '2',
          eventIndex: '8',
        }),
      },
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'internal_error',
        message: 'Dashboard integration request failed.',
        details: {
          cause: 'lookup failed',
        },
      },
    });
  });
});
