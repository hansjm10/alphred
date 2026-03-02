import { NextResponse } from 'next/server';
import {
  DashboardIntegrationError,
  toDashboardIntegrationError,
} from '../../../../../../../src/server/dashboard-errors';
import { toErrorResponse } from '../../../../../../../src/server/dashboard-http';
import { createDashboardService, type DashboardService } from '../../../../../../../src/server/dashboard-service';
import { parseRepositoryIdFromPathSegment } from '../../../../work-items/_shared/work-item-route-validation';

const STREAM_POLL_INTERVAL_MS = 350;
const STREAM_HEARTBEAT_INTERVAL_MS = 10_000;
const STREAM_BATCH_LIMIT = 200;

type RouteContext = {
  params: Promise<{
    name: string;
  }>;
};

type BoardEventsSnapshot = Awaited<ReturnType<DashboardService['getRepositoryBoardEventsSnapshot']>>;
type StreamWriter = (chunk: string) => void;

function parseOptionalNonNegativeInteger(name: string, value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new DashboardIntegrationError('invalid_request', `${name} must be a non-negative integer.`, {
      status: 400,
    });
  }

  return parsed;
}

async function resolveRepositoryId(context: RouteContext): Promise<number> {
  const params = await context.params;
  return parseRepositoryIdFromPathSegment(params.name);
}

function resolveResumeEventId(searchParams: URLSearchParams, request: Request): number {
  const queryEventId = parseOptionalNonNegativeInteger('lastEventId', searchParams.get('lastEventId'));
  const headerEventId = parseOptionalNonNegativeInteger('Last-Event-ID', request.headers.get('last-event-id'));
  return Math.max(queryEventId ?? 0, headerEventId ?? 0);
}

function encodeSseChunk(event: string, data: unknown, id?: number): string {
  const lines = [
    ...(id === undefined ? [] : [`id: ${id}`]),
    `event: ${event}`,
    `data: ${JSON.stringify(data)}`,
  ];
  return `${lines.join('\n')}\n\n`;
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

async function waitForNextPoll(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeoutId = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);

    const onAbort = () => {
      clearTimeout(timeoutId);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };

    signal.addEventListener('abort', onAbort, { once: true });
  });
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

  write(': stream_connected\n\n');

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

function createSseResponse(params: {
  request: Request;
  service: DashboardService;
  repositoryId: number;
  resumeEventId: number;
}): Response {
  const { request, service, repositoryId, resumeEventId } = params;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const write = (chunk: string): void => {
        if (!request.signal.aborted) {
          controller.enqueue(encoder.encode(chunk));
        }
      };

      try {
        await streamBoardEvents({
          request,
          service,
          repositoryId,
          resumeEventId,
          write,
        });
      } catch (error) {
        const integrationError = toDashboardIntegrationError(error);
        write(
          encodeSseChunk('board_error', {
            code: integrationError.code,
            message: integrationError.message,
          }),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const service = createDashboardService();

  try {
    const repositoryId = await resolveRepositoryId(context);
    const searchParams = new URL(request.url).searchParams;
    const lastEventId = resolveResumeEventId(searchParams, request);
    const limit = parseOptionalNonNegativeInteger('limit', searchParams.get('limit'));
    const transport = searchParams.get('transport');

    if (transport === 'sse' || request.headers.get('accept')?.includes('text/event-stream')) {
      return createSseResponse({
        request,
        service,
        repositoryId,
        resumeEventId: lastEventId,
      });
    }

    const snapshot = await service.getRepositoryBoardEventsSnapshot({
      repositoryId,
      lastEventId,
      limit: limit === undefined ? undefined : Math.max(1, limit),
    });
    return NextResponse.json(snapshot);
  } catch (error) {
    return toErrorResponse(error);
  }
}
