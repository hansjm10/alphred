import { DashboardIntegrationError } from '@dashboard/server/dashboard-errors';

export type StreamWriter = (chunk: string) => void;

export const SSE_CONNECTED_COMMENT = ': stream_connected\n\n';

const SSE_RESPONSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
} as const;

export function parseOptionalNonNegativeInteger(name: string, value: string | null): number | undefined {
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

export function resolveResumePointerFromQueryAndHeader(
  searchParams: URLSearchParams,
  request: Request,
  queryKey: string,
): number {
  const queryPointer = parseOptionalNonNegativeInteger(queryKey, searchParams.get(queryKey));
  const headerPointer = parseOptionalNonNegativeInteger('Last-Event-ID', request.headers.get('last-event-id'));
  return Math.max(queryPointer ?? 0, headerPointer ?? 0);
}

export function encodeSseChunk(event: string, data: unknown, id?: number): string {
  const lines = [
    ...(id === undefined ? [] : [`id: ${id}`]),
    `event: ${event}`,
    `data: ${JSON.stringify(data)}`,
  ];
  return `${lines.join('\n')}\n\n`;
}

export async function waitForNextPoll(delayMs: number, signal: AbortSignal): Promise<void> {
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

export function shouldUseSseTransport(searchParams: URLSearchParams, request: Request): boolean {
  return searchParams.get('transport') === 'sse' || request.headers.get('accept')?.includes('text/event-stream') === true;
}

export function resolveOptionalLimit(limit: number | undefined): number | undefined {
  return limit === undefined ? undefined : Math.max(1, limit);
}

type CreateSseResponseParams = {
  request: Request;
  stream: (write: StreamWriter) => Promise<void>;
  onError: (error: unknown, write: StreamWriter) => void;
};

export function createSseResponse(params: CreateSseResponseParams): Response {
  const { request, stream, onError } = params;
  const responseStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const write = (chunk: string): void => {
        if (!request.signal.aborted) {
          controller.enqueue(encoder.encode(chunk));
        }
      };

      try {
        await stream(write);
      } catch (error) {
        onError(error, write);
      } finally {
        controller.close();
      }
    },
  });

  return new Response(responseStream, {
    status: 200,
    headers: SSE_RESPONSE_HEADERS,
  });
}
