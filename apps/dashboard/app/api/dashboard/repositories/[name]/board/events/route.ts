import { NextResponse } from 'next/server';
import {
  toDashboardIntegrationError,
} from '../../../../../../../src/server/dashboard-errors';
import { toErrorResponse } from '../../../../../../../src/server/dashboard-http';
import { createDashboardService, type DashboardService } from '../../../../../../../src/server/dashboard-service';
import { parseRepositoryIdFromPathSegment } from '../../../../work-items/_shared/work-item-route-validation';
import {
  createSseResponse,
  encodeSseChunk,
  parseOptionalNonNegativeInteger,
  resolveOptionalLimit,
  resolveResumePointerFromQueryAndHeader,
  SSE_CONNECTED_COMMENT,
  shouldUseSseTransport,
  type StreamWriter,
  waitForNextPoll,
} from '../../../../_shared/sse';

const STREAM_POLL_INTERVAL_MS = 350;
const STREAM_HEARTBEAT_INTERVAL_MS = 10_000;
const STREAM_BATCH_LIMIT = 200;

type RouteContext = {
  params: Promise<{
    name: string;
  }>;
};

type BoardEventsSnapshot = Awaited<ReturnType<DashboardService['getRepositoryBoardEventsSnapshot']>>;

async function resolveRepositoryId(context: RouteContext): Promise<number> {
  const params = await context.params;
  return parseRepositoryIdFromPathSegment(params.name);
}

function emitBoardState(
  write: StreamWriter,
  snapshot: BoardEventsSnapshot,
  lastKnownLatestEventId: number | null,
): number {
  if (lastKnownLatestEventId === null || snapshot.latestEventId !== lastKnownLatestEventId) {
    write(
      encodeSseChunk('board_state', {
        connectionState: 'live',
        latestEventId: snapshot.latestEventId,
      }),
    );
  }

  return snapshot.latestEventId;
}

function emitBoardEvents(
  write: StreamWriter,
  snapshot: BoardEventsSnapshot,
  lastEventId: number,
): { lastEventId: number; emittedAtMs: number | null } {
  let nextEventId = lastEventId;
  for (const event of snapshot.events) {
    write(encodeSseChunk('board_event', event, event.id));
    nextEventId = event.id;
  }

  return {
    lastEventId: nextEventId,
    emittedAtMs: snapshot.events.length > 0 ? Date.now() : null,
  };
}

async function streamBoardEvents(params: {
  request: Request;
  service: DashboardService;
  repositoryId: number;
  resumeEventId: number;
  write: StreamWriter;
}): Promise<void> {
  const { request, service, repositoryId, resumeEventId, write } = params;
  let lastEventId = resumeEventId;
  let lastHeartbeatMs = Date.now();
  let lastKnownLatestEventId: number | null = null;

  write(SSE_CONNECTED_COMMENT);

  while (!request.signal.aborted) {
    const snapshot = await service.getRepositoryBoardEventsSnapshot({
      repositoryId,
      lastEventId,
      limit: STREAM_BATCH_LIMIT,
    });

    lastKnownLatestEventId = emitBoardState(write, snapshot, lastKnownLatestEventId);

    const emitted = emitBoardEvents(write, snapshot, lastEventId);
    lastEventId = emitted.lastEventId;
    if (emitted.emittedAtMs !== null) {
      lastHeartbeatMs = emitted.emittedAtMs;
    }

    if (snapshot.latestEventId > lastEventId) {
      continue;
    }

    const now = Date.now();
    if (now - lastHeartbeatMs >= STREAM_HEARTBEAT_INTERVAL_MS) {
      write(encodeSseChunk('heartbeat', { lastEventId }));
      lastHeartbeatMs = now;
    }

    await waitForNextPoll(STREAM_POLL_INTERVAL_MS, request.signal);
  }
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const service = createDashboardService();

  try {
    const repositoryId = await resolveRepositoryId(context);
    const searchParams = new URL(request.url).searchParams;
    const lastEventId = resolveResumePointerFromQueryAndHeader(searchParams, request, 'lastEventId');
    const limit = parseOptionalNonNegativeInteger('limit', searchParams.get('limit'));

    if (shouldUseSseTransport(searchParams, request)) {
      return createSseResponse({
        request,
        stream: async (write) => {
          await streamBoardEvents({
            request,
            service,
            repositoryId,
            resumeEventId: lastEventId,
            write,
          });
        },
        onError: (error, write) => {
          const integrationError = toDashboardIntegrationError(error);
          write(
            encodeSseChunk('board_error', {
              code: integrationError.code,
              message: integrationError.message,
            }),
          );
        },
      });
    }

    const snapshot = await service.getRepositoryBoardEventsSnapshot({
      repositoryId,
      lastEventId,
      limit: resolveOptionalLimit(limit),
    });
    return NextResponse.json(snapshot);
  } catch (error) {
    return toErrorResponse(error);
  }
}
