import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createDashboardServiceMock, getRunNodeStreamSnapshotMock } = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  getRunNodeStreamSnapshotMock: vi.fn(),
}));

vi.mock('../../../../../../../../src/server/dashboard-service', () => ({
  createDashboardService: createDashboardServiceMock,
}));

import { GET } from './route';

function buildStreamEvent(sequence: number) {
  return {
    id: sequence,
    workflowRunId: 11,
    runNodeId: 4,
    attempt: 2,
    sequence,
    type: 'assistant',
    timestamp: sequence,
    contentChars: 11,
    contentPreview: `event-${sequence}`,
    metadata: null,
    usage: null,
    createdAt: '2026-02-18T00:00:00.000Z',
  };
}

type ParsedSseFrame = {
  event: string | null;
  data: unknown;
  id: number | null;
};

function parseSseFrames(rawStream: string): ParsedSseFrame[] {
  const frames: ParsedSseFrame[] = [];

  for (const chunk of rawStream.split('\n\n')) {
    const lines = chunk
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith(':'));
    if (lines.length === 0) {
      continue;
    }

    let event: string | null = null;
    let id: number | null = null;
    let data: unknown = null;

    for (const line of lines) {
      if (line.startsWith('event:')) {
        event = line.slice('event:'.length).trim();
      } else if (line.startsWith('id:')) {
        const parsedId = Number(line.slice('id:'.length).trim());
        id = Number.isInteger(parsedId) ? parsedId : null;
      } else if (line.startsWith('data:')) {
        const payload = line.slice('data:'.length).trim();
        data = JSON.parse(payload);
      }
    }

    frames.push({ event, data, id });
  }

  return frames;
}

describe('GET /api/dashboard/runs/[runId]/nodes/[runNodeId]/stream', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    getRunNodeStreamSnapshotMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      getRunNodeStreamSnapshot: getRunNodeStreamSnapshotMock,
    });
  });

  it('returns run-node stream snapshot for a valid request', async () => {
    getRunNodeStreamSnapshotMock.mockResolvedValue({
      workflowRunId: 11,
      runNodeId: 4,
      attempt: 2,
      nodeStatus: 'running',
      ended: false,
      latestSequence: 7,
      events: [],
    });

    const response = await GET(
      new Request('http://localhost/api/dashboard/runs/11/nodes/4/stream?attempt=2&lastEventSequence=3'),
      {
        params: Promise.resolve({ runId: '11', runNodeId: '4' }),
      },
    );

    expect(getRunNodeStreamSnapshotMock).toHaveBeenCalledWith({
      runId: 11,
      runNodeId: 4,
      attempt: 2,
      lastEventSequence: 3,
      limit: undefined,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      workflowRunId: 11,
      runNodeId: 4,
      attempt: 2,
      nodeStatus: 'running',
      ended: false,
      latestSequence: 7,
      events: [],
    });
  });

  it('returns 400 when attempt query is missing', async () => {
    const response = await GET(
      new Request('http://localhost/api/dashboard/runs/11/nodes/4/stream'),
      {
        params: Promise.resolve({ runId: '11', runNodeId: '4' }),
      },
    );

    expect(getRunNodeStreamSnapshotMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'attempt must be a positive integer.',
      },
    });
  });

  it('returns 400 when runNodeId is invalid', async () => {
    const response = await GET(
      new Request('http://localhost/api/dashboard/runs/11/nodes/not-a-number/stream?attempt=1'),
      {
        params: Promise.resolve({ runId: '11', runNodeId: 'not-a-number' }),
      },
    );

    expect(getRunNodeStreamSnapshotMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'runNodeId must be a positive integer.',
      },
    });
  });

  it('maps service failures to integration error responses', async () => {
    getRunNodeStreamSnapshotMock.mockRejectedValue(new Error('snapshot lookup failed'));

    const response = await GET(
      new Request('http://localhost/api/dashboard/runs/11/nodes/4/stream?attempt=1'),
      {
        params: Promise.resolve({ runId: '11', runNodeId: '4' }),
      },
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'internal_error',
        message: 'Dashboard integration request failed.',
        details: {
          cause: 'snapshot lookup failed',
        },
      },
    });
  });

  it('drains ended backlog batches before emitting stream_end', async () => {
    const firstBatch = Array.from({ length: 200 }, (_, index) => buildStreamEvent(index + 1));
    const secondBatch = Array.from({ length: 5 }, (_, index) => buildStreamEvent(index + 201));
    getRunNodeStreamSnapshotMock
      .mockResolvedValueOnce({
        workflowRunId: 11,
        runNodeId: 4,
        attempt: 2,
        nodeStatus: 'completed',
        ended: true,
        latestSequence: 205,
        events: firstBatch,
      })
      .mockResolvedValueOnce({
        workflowRunId: 11,
        runNodeId: 4,
        attempt: 2,
        nodeStatus: 'completed',
        ended: true,
        latestSequence: 205,
        events: secondBatch,
      });

    const response = await GET(
      new Request('http://localhost/api/dashboard/runs/11/nodes/4/stream?attempt=2&transport=sse'),
      {
        params: Promise.resolve({ runId: '11', runNodeId: '4' }),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(getRunNodeStreamSnapshotMock).toHaveBeenNthCalledWith(1, {
      runId: 11,
      runNodeId: 4,
      attempt: 2,
      lastEventSequence: 0,
      limit: 200,
    });
    expect(getRunNodeStreamSnapshotMock).toHaveBeenNthCalledWith(2, {
      runId: 11,
      runNodeId: 4,
      attempt: 2,
      lastEventSequence: 200,
      limit: 200,
    });
    expect(getRunNodeStreamSnapshotMock).toHaveBeenCalledTimes(2);

    const sseFrames = parseSseFrames(await response.text());
    const streamEventFrames = sseFrames.filter(frame => frame.event === 'stream_event');
    expect(streamEventFrames).toHaveLength(205);
    expect((streamEventFrames[streamEventFrames.length - 1]?.data as { sequence: number }).sequence).toBe(205);

    const lastEventIndex = sseFrames.reduce(
      (latestIndex, frame, index) => (frame.event === 'stream_event' ? index : latestIndex),
      -1,
    );
    const streamEndIndex = sseFrames.findIndex(frame => frame.event === 'stream_end');
    expect(streamEndIndex).toBeGreaterThan(lastEventIndex);
    expect((sseFrames[streamEndIndex]?.data as { latestSequence: number }).latestSequence).toBe(205);
    expect(sseFrames[streamEndIndex]?.id).toBe(205);
  });
});
