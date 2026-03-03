import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createDashboardServiceMock, getRepositoryBoardEventsSnapshotMock } = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  getRepositoryBoardEventsSnapshotMock: vi.fn(),
}));

vi.mock('@dashboard/server/dashboard-service', () => ({
  createDashboardService: createDashboardServiceMock,
}));

import { GET } from './route';

type ParsedSseFrame = {
  event: string | null;
  data: unknown;
  id: number | null;
};

function createContext(name: string): { params: Promise<{ name: string }> } {
  return {
    params: Promise.resolve({ name }),
  };
}

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

describe('GET /api/dashboard/repositories/[name]/board/events', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    getRepositoryBoardEventsSnapshotMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      getRepositoryBoardEventsSnapshot: getRepositoryBoardEventsSnapshotMock,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns board-event snapshot for a valid request', async () => {
    getRepositoryBoardEventsSnapshotMock.mockResolvedValue({
      repositoryId: 7,
      latestEventId: 21,
      events: [],
    });

    const response = await GET(
      new Request('http://localhost/api/dashboard/repositories/7/board/events?lastEventId=5'),
      createContext('7'),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      repositoryId: 7,
      latestEventId: 21,
      events: [],
    });
    expect(getRepositoryBoardEventsSnapshotMock).toHaveBeenCalledWith({
      repositoryId: 7,
      lastEventId: 5,
      limit: undefined,
    });
  });

  it('uses the higher resume pointer from Last-Event-ID and query', async () => {
    getRepositoryBoardEventsSnapshotMock.mockResolvedValue({
      repositoryId: 7,
      latestEventId: 21,
      events: [],
    });

    const response = await GET(
      new Request('http://localhost/api/dashboard/repositories/7/board/events?lastEventId=4', {
        headers: {
          'last-event-id': '9',
        },
      }),
      createContext('7'),
    );

    expect(response.status).toBe(200);
    expect(getRepositoryBoardEventsSnapshotMock).toHaveBeenCalledWith({
      repositoryId: 7,
      lastEventId: 9,
      limit: undefined,
    });
  });

  it('returns 400 when Last-Event-ID header is invalid', async () => {
    const response = await GET(
      new Request('http://localhost/api/dashboard/repositories/7/board/events', {
        headers: {
          'last-event-id': 'oops',
        },
      }),
      createContext('7'),
    );

    expect(getRepositoryBoardEventsSnapshotMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'Last-Event-ID must be a non-negative integer.',
      },
    });
  });

  it('emits board_state and board_event frames over SSE', async () => {
    getRepositoryBoardEventsSnapshotMock.mockResolvedValue({
      repositoryId: 7,
      latestEventId: 1,
      events: [
        {
          id: 1,
          repositoryId: 7,
          workItemId: 15,
          eventType: 'created',
          actorType: 'human',
          actorLabel: 'alice',
          payload: { title: 'Draft task' },
          createdAt: '2026-03-02T18:45:00.000Z',
        },
      ],
    });

    const abortController = new AbortController();
    const response = await GET(
      new Request('http://localhost/api/dashboard/repositories/7/board/events?transport=sse', {
        headers: {
          accept: 'text/event-stream',
        },
        signal: abortController.signal,
      }),
      createContext('7'),
    );

    setTimeout(() => abortController.abort(), 0);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const frames = parseSseFrames(await response.text());

    expect(frames.some(frame => frame.event === 'board_state')).toBe(true);
    const boardEventFrame = frames.find(frame => frame.event === 'board_event');
    expect(boardEventFrame).toBeDefined();
    expect(boardEventFrame?.id).toBe(1);
    expect(boardEventFrame?.data).toMatchObject({
      id: 1,
      repositoryId: 7,
      workItemId: 15,
      eventType: 'created',
    });
    expect(getRepositoryBoardEventsSnapshotMock).toHaveBeenCalledWith({
      repositoryId: 7,
      lastEventId: 0,
      limit: 200,
    });
  });

  it('emits heartbeat frames when idle beyond the heartbeat interval', async () => {
    getRepositoryBoardEventsSnapshotMock.mockResolvedValue({
      repositoryId: 7,
      latestEventId: 0,
      events: [],
    });

    const dateNowSpy = vi.spyOn(Date, 'now');
    dateNowSpy.mockImplementationOnce(() => 0).mockImplementation(() => 12_000);

    const abortController = new AbortController();
    const response = await GET(
      new Request('http://localhost/api/dashboard/repositories/7/board/events?transport=sse', {
        headers: {
          accept: 'text/event-stream',
        },
        signal: abortController.signal,
      }),
      createContext('7'),
    );

    setTimeout(() => abortController.abort(), 0);

    const frames = parseSseFrames(await response.text());
    const heartbeatFrame = frames.find(frame => frame.event === 'heartbeat');
    expect(heartbeatFrame).toBeDefined();
    expect(heartbeatFrame?.data).toEqual({
      lastEventId: 0,
    });
  });

  it('stops SSE polling when the request is aborted', async () => {
    getRepositoryBoardEventsSnapshotMock.mockResolvedValue({
      repositoryId: 7,
      latestEventId: 0,
      events: [],
    });

    const abortController = new AbortController();
    const response = await GET(
      new Request('http://localhost/api/dashboard/repositories/7/board/events?transport=sse', {
        headers: {
          accept: 'text/event-stream',
        },
        signal: abortController.signal,
      }),
      createContext('7'),
    );

    abortController.abort();

    const frames = parseSseFrames(await response.text());
    expect(frames.some(frame => frame.event === 'board_state')).toBe(true);
    expect(getRepositoryBoardEventsSnapshotMock).toHaveBeenCalledTimes(1);
  });
});
