import { NextResponse } from 'next/server';
import {
  DashboardIntegrationError,
  toDashboardIntegrationError,
} from '../../../../../../../../src/server/dashboard-errors';
import { toErrorResponse } from '../../../../../../../../src/server/dashboard-http';
import { createDashboardService, type DashboardService } from '../../../../../../../../src/server/dashboard-service';
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
} from '../../../../../_shared/sse';

const STREAM_POLL_INTERVAL_MS = 350;
const STREAM_HEARTBEAT_INTERVAL_MS = 10_000;
const STREAM_BATCH_LIMIT = 200;

type RunNodeStreamRouteContext = {
  params: Promise<{
    runId: string;
    runNodeId: string;
  }>;
};

type RunNodeStreamSnapshot = Awaited<ReturnType<DashboardService['getRunNodeStreamSnapshot']>>;

function parsePositiveInteger(name: string, value: string | null): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new DashboardIntegrationError('invalid_request', `${name} must be a positive integer.`, {
      status: 400,
    });
  }

  return parsed;
}

function resolveResumeSequence(searchParams: URLSearchParams, request: Request): number {
  return resolveResumePointerFromQueryAndHeader(searchParams, request, 'lastEventSequence');
}

function emitStreamState(
  write: StreamWriter,
  snapshot: RunNodeStreamSnapshot,
  lastConnectionState: string | null,
): string {
  const connectionState = snapshot.ended ? 'ended' : 'live';
  if (connectionState !== lastConnectionState) {
    write(
      encodeSseChunk('stream_state', {
        connectionState,
        nodeStatus: snapshot.nodeStatus,
        latestSequence: snapshot.latestSequence,
      }),
    );
  }

  return connectionState;
}

function emitSnapshotEvents(
  write: StreamWriter,
  snapshot: RunNodeStreamSnapshot,
  lastEventSequence: number,
): { lastEventSequence: number; heartbeatAtMs: number | null } {
  let nextSequence = lastEventSequence;
  for (const event of snapshot.events) {
    write(encodeSseChunk('stream_event', event, event.sequence));
    nextSequence = event.sequence;
  }

  return {
    lastEventSequence: nextSequence,
    heartbeatAtMs: snapshot.events.length > 0 ? Date.now() : null,
  };
}

function resolveSnapshotAction(
  snapshot: RunNodeStreamSnapshot,
  lastEventSequence: number,
): 'end' | 'wait' | 'drain' | 'continue' {
  const hasUnseenEvents = snapshot.latestSequence > lastEventSequence;
  if (snapshot.ended && !hasUnseenEvents) {
    return 'end';
  }

  if (snapshot.ended && hasUnseenEvents) {
    return snapshot.events.length === 0 ? 'wait' : 'drain';
  }

  return 'continue';
}

function emitStreamEnd(write: StreamWriter, snapshot: RunNodeStreamSnapshot): void {
  write(
    encodeSseChunk(
      'stream_end',
      {
        connectionState: 'ended',
        nodeStatus: snapshot.nodeStatus,
        latestSequence: snapshot.latestSequence,
      },
      snapshot.latestSequence > 0 ? snapshot.latestSequence : undefined,
    ),
  );
}

async function streamRunNodeEvents(params: {
  request: Request;
  service: DashboardService;
  runId: number;
  runNodeId: number;
  attempt: number;
  resumeSequence: number;
  write: StreamWriter;
}): Promise<void> {
  const { request, service, runId, runNodeId, attempt, resumeSequence, write } = params;
  let lastEventSequence = resumeSequence;
  let lastHeartbeatMs = Date.now();
  let lastConnectionState: string | null = null;

  write(SSE_CONNECTED_COMMENT);

  while (!request.signal.aborted) {
    const snapshot = await service.getRunNodeStreamSnapshot({
      runId,
      runNodeId,
      attempt,
      lastEventSequence,
      limit: STREAM_BATCH_LIMIT,
    });

    lastConnectionState = emitStreamState(write, snapshot, lastConnectionState);

    const emitted = emitSnapshotEvents(write, snapshot, lastEventSequence);
    lastEventSequence = emitted.lastEventSequence;
    if (emitted.heartbeatAtMs !== null) {
      lastHeartbeatMs = emitted.heartbeatAtMs;
    }

    const snapshotAction = resolveSnapshotAction(snapshot, lastEventSequence);
    if (snapshotAction === 'end') {
      emitStreamEnd(write, snapshot);
      break;
    }

    if (snapshotAction === 'wait') {
      await waitForNextPoll(STREAM_POLL_INTERVAL_MS, request.signal);
      continue;
    }

    if (snapshotAction === 'drain') {
      continue;
    }

    const now = Date.now();
    if (now - lastHeartbeatMs >= STREAM_HEARTBEAT_INTERVAL_MS) {
      write(encodeSseChunk('heartbeat', { lastEventSequence }));
      lastHeartbeatMs = now;
    }

    await waitForNextPoll(STREAM_POLL_INTERVAL_MS, request.signal);
  }
}

export async function GET(request: Request, context: RunNodeStreamRouteContext): Promise<Response> {
  const service = createDashboardService();

  try {
    const params = await context.params;
    const runId = parsePositiveInteger('runId', params.runId);
    const runNodeId = parsePositiveInteger('runNodeId', params.runNodeId);

    const searchParams = new URL(request.url).searchParams;
    const attempt = parsePositiveInteger('attempt', searchParams.get('attempt'));
    const lastEventSequence = resolveResumeSequence(searchParams, request);
    const limit = parseOptionalNonNegativeInteger('limit', searchParams.get('limit'));

    if (shouldUseSseTransport(searchParams, request)) {
      return createSseResponse({
        request,
        stream: async (write) => {
          await streamRunNodeEvents({
            request,
            service,
            runId,
            runNodeId,
            attempt,
            resumeSequence: lastEventSequence,
            write,
          });
        },
        onError: (error, write) => {
          const integrationError = toDashboardIntegrationError(error);
          write(
            encodeSseChunk('stream_error', {
              code: integrationError.code,
              message: integrationError.message,
            }),
          );
        },
      });
    }

    const snapshot = await service.getRunNodeStreamSnapshot({
      runId,
      runNodeId,
      attempt,
      lastEventSequence,
      limit: resolveOptionalLimit(limit),
    });

    return NextResponse.json(snapshot);
  } catch (error) {
    return toErrorResponse(error);
  }
}
