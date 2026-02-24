import { NextResponse } from 'next/server';
import {
  DashboardIntegrationError,
  toDashboardIntegrationError,
} from '../../../../../../../../src/server/dashboard-errors';
import { toErrorResponse } from '../../../../../../../../src/server/dashboard-http';
import { createDashboardService, type DashboardService } from '../../../../../../../../src/server/dashboard-service';

const STREAM_POLL_INTERVAL_MS = 350;
const STREAM_HEARTBEAT_INTERVAL_MS = 10_000;
const STREAM_BATCH_LIMIT = 200;

type RunNodeStreamRouteContext = {
  params: Promise<{
    runId: string;
    runNodeId: string;
  }>;
};

function parsePositiveInteger(name: string, value: string | null): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new DashboardIntegrationError('invalid_request', `${name} must be a positive integer.`, {
      status: 400,
    });
  }

  return parsed;
}

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

function resolveResumeSequence(searchParams: URLSearchParams, request: Request): number {
  const querySequence = parseOptionalNonNegativeInteger('lastEventSequence', searchParams.get('lastEventSequence'));
  const headerSequence = parseOptionalNonNegativeInteger('Last-Event-ID', request.headers.get('last-event-id'));
  return Math.max(querySequence ?? 0, headerSequence ?? 0);
}

function encodeSseChunk(event: string, data: unknown, id?: number): string {
  const lines: string[] = [];
  if (id !== undefined) {
    lines.push(`id: ${id}`);
  }
  lines.push(`event: ${event}`);
  lines.push(`data: ${JSON.stringify(data)}`);
  return `${lines.join('\n')}\n\n`;
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

function createSseResponse(params: {
  request: Request;
  service: DashboardService;
  runId: number;
  runNodeId: number;
  attempt: number;
  resumeSequence: number;
}): Response {
  const { request, service, runId, runNodeId, attempt, resumeSequence } = params;
  let lastEventSequence = resumeSequence;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const write = (chunk: string): void => {
        if (!request.signal.aborted) {
          controller.enqueue(encoder.encode(chunk));
        }
      };

      let lastHeartbeatMs = Date.now();
      let lastConnectionState: string | null = null;

      try {
        write(': stream_connected\n\n');

        while (!request.signal.aborted) {
          const snapshot = await service.getRunNodeStreamSnapshot({
            runId,
            runNodeId,
            attempt,
            lastEventSequence,
            limit: STREAM_BATCH_LIMIT,
          });

          const connectionState = snapshot.ended ? 'ended' : 'live';
          if (connectionState !== lastConnectionState) {
            write(
              encodeSseChunk('stream_state', {
                connectionState,
                nodeStatus: snapshot.nodeStatus,
                latestSequence: snapshot.latestSequence,
              }),
            );
            lastConnectionState = connectionState;
          }

          for (const event of snapshot.events) {
            write(encodeSseChunk('stream_event', event, event.sequence));
            lastEventSequence = event.sequence;
            lastHeartbeatMs = Date.now();
          }

          if (snapshot.ended) {
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
            break;
          }

          if (Date.now() - lastHeartbeatMs >= STREAM_HEARTBEAT_INTERVAL_MS) {
            write(encodeSseChunk('heartbeat', { lastEventSequence }));
            lastHeartbeatMs = Date.now();
          }

          await waitForNextPoll(STREAM_POLL_INTERVAL_MS, request.signal);
        }
      } catch (error) {
        const integrationError = toDashboardIntegrationError(error);
        write(
          encodeSseChunk('stream_error', {
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
    const transport = searchParams.get('transport');

    if (transport === 'sse' || request.headers.get('accept')?.includes('text/event-stream')) {
      return createSseResponse({
        request,
        service,
        runId,
        runNodeId,
        attempt,
        resumeSequence: lastEventSequence,
      });
    }

    const snapshot = await service.getRunNodeStreamSnapshot({
      runId,
      runNodeId,
      attempt,
      lastEventSequence,
      limit: limit === undefined ? undefined : Math.max(1, limit),
    });

    return NextResponse.json(snapshot);
  } catch (error) {
    return toErrorResponse(error);
  }
}
