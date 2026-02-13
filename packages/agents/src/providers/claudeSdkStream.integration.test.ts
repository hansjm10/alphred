import type { ProviderEvent, ProviderRunOptions } from '@alphred/shared';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeProvider, type ClaudeSdkQuery } from './claude.js';

const defaultOptions: ProviderRunOptions = {
  workingDirectory: '/tmp/alphred-claude-integration',
};

type CapturedSdkInvocation = {
  prompt?: unknown;
  options?: unknown;
};

function createMockQuery(messages: readonly unknown[], capture?: CapturedSdkInvocation): ClaudeSdkQuery {
  return ((params: { prompt: string | AsyncIterable<unknown>; options?: unknown }) => {
    if (capture) {
      capture.prompt = params.prompt;
      capture.options = params.options;
    }

    return (async function* () {
      for (const message of messages) {
        yield message;
      }
    })();
  }) as unknown as ClaudeSdkQuery;
}

function createProviderForFixture(messages: readonly unknown[], capture?: CapturedSdkInvocation): ClaudeProvider {
  return new ClaudeProvider(
    undefined,
    () => ({
      authMode: 'api_key',
      model: 'claude-3-7-sonnet-latest',
      apiKey: 'sk-test',
      apiKeySource: 'CLAUDE_API_KEY',
    }),
    createMockQuery(messages, capture),
  );
}

async function collectEvents(
  provider: ClaudeProvider,
  prompt = 'Implement issue #48 runtime tests.',
  options: ProviderRunOptions = defaultOptions,
): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of provider.run(prompt, options)) {
    events.push(event);
  }
  return events;
}

const sdkStreamFixtures = {
  success: [
    { type: 'system', subtype: 'init' },
    {
      type: 'tool_progress',
      tool_name: 'Bash',
      tool_use_id: 'tool-1',
      parent_tool_use_id: null,
      elapsed_time_seconds: 1,
    },
    {
      type: 'tool_use_summary',
      summary: 'pnpm test exited 0',
      preceding_tool_use_ids: ['tool-1'],
    },
    {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text: 'All required changes are complete.',
          },
        ],
      },
      parent_tool_use_id: null,
    },
    {
      type: 'result',
      subtype: 'success',
      result: 'All required changes are complete.',
      usage: {
        input_tokens: 20,
        output_tokens: 8,
        cache_read_input_tokens: 0,
      },
    },
  ] as const,
  mixedToolUseAssistantThenProgress: [
    {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tool-42',
            name: 'Bash',
            input: { command: 'echo hi' },
          },
          {
            type: 'text',
            text: 'Continuing after tool call.',
          },
        ],
      },
      parent_tool_use_id: null,
    },
    {
      type: 'tool_progress',
      tool_name: 'Bash',
      tool_use_id: 'tool-42',
      parent_tool_use_id: null,
      elapsed_time_seconds: 2,
    },
    {
      type: 'result',
      subtype: 'success',
      result: 'done',
      usage: {
        input_tokens: 8,
        output_tokens: 4,
      },
    },
  ] as const,
  mixedToolUseProgressThenAssistant: [
    {
      type: 'tool_progress',
      tool_name: 'Bash',
      tool_use_id: 'tool-99',
      parent_tool_use_id: null,
      elapsed_time_seconds: 1,
    },
    {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tool-99',
            name: 'Bash',
            input: { command: 'echo after progress' },
          },
          {
            type: 'text',
            text: 'Tool finished.',
          },
        ],
      },
      parent_tool_use_id: null,
    },
    {
      type: 'result',
      subtype: 'success',
      result: 'Tool finished.',
      usage: {
        input_tokens: 9,
        output_tokens: 5,
      },
    },
  ] as const,
  partial: [
    {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text: 'Partial answer before stream ended unexpectedly.',
          },
        ],
      },
      parent_tool_use_id: null,
    },
  ] as const,
  malformed: [
    {
      type: 'result',
      subtype: 'success',
      result: 'done',
      usage: {
        input_tokens: 10,
        output_tokens: '3',
      },
    },
  ] as const,
  failureTimeout: [
    {
      type: 'result',
      subtype: 'error_during_execution',
      errors: ['transport timeout'],
      usage: {
        input_tokens: 12,
        output_tokens: 3,
      },
    },
  ] as const,
  failureInternal: [
    {
      type: 'result',
      subtype: 'error_during_execution',
      errors: ['Sample rate mismatch in audio parser'],
      usage: {
        input_tokens: 12,
        output_tokens: 3,
      },
    },
  ] as const,
  failureRateLimitedStatus: [
    {
      type: 'result',
      subtype: 'error_during_execution',
      status: 429,
      errors: ['quota exceeded for this workspace'],
      usage: {
        input_tokens: 12,
        output_tokens: 3,
      },
    },
  ] as const,
  failureTransportCode: [
    {
      type: 'result',
      subtype: 'error_during_execution',
      errors: ['connection dropped'],
      error: {
        code: 'ECONNRESET',
        message: 'socket hang up',
      },
      usage: {
        input_tokens: 12,
        output_tokens: 3,
      },
    },
  ] as const,
};

describe('claude provider sdk stream integration fixtures', () => {
  it('maps the success fixture into deterministic ordered provider events', async () => {
    const capture: CapturedSdkInvocation = {};
    const provider = createProviderForFixture(sdkStreamFixtures.success, capture);

    const events = await collectEvents(provider, 'Apply integration fixture tests.');

    expect(events.map((event) => event.type)).toEqual(['system', 'tool_use', 'tool_result', 'assistant', 'usage', 'result']);
    expect(events[1]?.content).toBe('Bash');
    expect(events[2]?.content).toBe('pnpm test exited 0');
    expect(events[3]?.content).toBe('All required changes are complete.');
    expect(events[5]?.content).toBe('All required changes are complete.');
    expect(events[4]?.metadata).toMatchObject({
      input_tokens: 20,
      output_tokens: 8,
      total_tokens: 28,
      cache_read_input_tokens: 0,
      usage: {
        input_tokens: 20,
        output_tokens: 8,
        total_tokens: 28,
        cache_read_input_tokens: 0,
      },
    });

    expect(capture.prompt).toBe('Apply integration fixture tests.');
    expect(capture.options).toMatchObject({
      cwd: '/tmp/alphred-claude-integration',
      model: 'claude-3-7-sonnet-latest',
      env: {
        CLAUDE_API_KEY: 'sk-test',
        ANTHROPIC_API_KEY: 'sk-test',
      },
    });
  });

  it('passes an abort controller when timeout is configured', async () => {
    const capture: CapturedSdkInvocation = {};
    const provider = createProviderForFixture(sdkStreamFixtures.success, capture);

    await collectEvents(provider, 'Apply integration fixture tests.', {
      ...defaultOptions,
      timeout: 25_000,
    });

    expect(capture.options).toMatchObject({
      abortController: expect.any(AbortController),
    });
  });

  it('maps timeout expiry into a deterministic claude timeout error', async () => {
    vi.useFakeTimers();
    try {
      let resolveQueryStarted: (() => void) | undefined;
      const queryStarted = new Promise<void>((resolve) => {
        resolveQueryStarted = resolve;
      });

      const provider = new ClaudeProvider(
        undefined,
        () => ({
          authMode: 'api_key',
          model: 'claude-3-7-sonnet-latest',
          apiKey: 'sk-test',
          apiKeySource: 'CLAUDE_API_KEY',
        }),
        ((params: { prompt: string | AsyncIterable<unknown>; options?: unknown }) => {
          const options = params.options as { abortController?: AbortController } | undefined;
          const abortController = options?.abortController;
          resolveQueryStarted?.();
          return (async function* () {
            if (!abortController) {
              throw new Error('missing abort controller');
            }
            yield { type: 'system', subtype: 'waiting_for_timeout' };
            await new Promise<never>((_resolve, reject) => {
              if (abortController.signal.aborted) {
                reject(new Error('aborted'));
                return;
              }
              abortController.signal.addEventListener(
                'abort',
                () => {
                  reject(new Error('aborted'));
                },
                { once: true },
              );
            });
          })();
        }) as unknown as ClaudeSdkQuery,
      );

      const pendingEvents = collectEvents(provider, 'Apply integration fixture tests.', {
        ...defaultOptions,
        timeout: 25_000,
      });
      const pendingTimeoutError = expect(pendingEvents).rejects.toMatchObject({
        code: 'CLAUDE_TIMEOUT',
        retryable: true,
        details: {
          classification: 'timeout',
          retryable: true,
          timeout: 25_000,
        },
      });
      await queryStarted;
      await vi.advanceTimersByTimeAsync(25_000);

      await pendingTimeoutError;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('deduplicates tool_use events when assistant tool_use is followed by tool_progress for the same id', async () => {
    const provider = createProviderForFixture(sdkStreamFixtures.mixedToolUseAssistantThenProgress);

    const events = await collectEvents(provider);
    expect(events.map((event) => event.type)).toEqual(['system', 'tool_use', 'assistant', 'usage', 'result']);
    expect(events.filter((event) => event.type === 'tool_use')).toHaveLength(1);
    expect(events.find((event) => event.type === 'tool_use')?.metadata).toMatchObject({
      toolUseId: 'tool-42',
    });
  });

  it('deduplicates tool_use events when tool_progress is followed by assistant tool_use for the same id', async () => {
    const provider = createProviderForFixture(sdkStreamFixtures.mixedToolUseProgressThenAssistant);

    const events = await collectEvents(provider);
    expect(events.map((event) => event.type)).toEqual(['system', 'tool_use', 'assistant', 'usage', 'result']);
    expect(events.filter((event) => event.type === 'tool_use')).toHaveLength(1);
    expect(events.find((event) => event.type === 'tool_use')?.metadata).toMatchObject({
      toolUseId: 'tool-99',
    });
  });

  it('ignores unknown assistant content blocks while preserving known mapped blocks', async () => {
    const provider = createProviderForFixture([
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'image',
              source: 'https://example.com/image.png',
            },
            {
              type: 'text',
              text: 'Tool finished.',
            },
          ],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        result: 'Tool finished.',
        usage: {
          input_tokens: 9,
          output_tokens: 5,
        },
      },
    ]);

    const events = await collectEvents(provider);
    expect(events.map((event) => event.type)).toEqual(['system', 'assistant', 'usage', 'result']);
    expect(events[1]?.content).toBe('Tool finished.');
    expect(events[3]?.content).toBe('Tool finished.');
  });

  it('preserves assistant and result content whitespace without trimming', async () => {
    const provider = createProviderForFixture([
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: '  keep boundary whitespace  ',
            },
            {
              type: 'text',
              text: '',
            },
            {
              type: 'text',
              text: '   ',
            },
          ],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        result: '   ',
        usage: {
          input_tokens: 9,
          output_tokens: 5,
        },
      },
    ]);

    const events = await collectEvents(provider);
    expect(events.map((event) => event.type)).toEqual(['system', 'assistant', 'assistant', 'assistant', 'usage', 'result']);
    expect(events[1]?.content).toBe('  keep boundary whitespace  ');
    expect(events[2]?.content).toBe('');
    expect(events[3]?.content).toBe('   ');
    expect(events[5]?.content).toBe('   ');
  });

  it('cleans up timeout handles when sdk query construction fails synchronously', async () => {
    vi.useFakeTimers();
    try {
      const provider = new ClaudeProvider(
        undefined,
        () => ({
          authMode: 'api_key',
          model: 'claude-3-7-sonnet-latest',
          apiKey: 'sk-test',
          apiKeySource: 'CLAUDE_API_KEY',
        }),
        ((params: { prompt: string | AsyncIterable<unknown>; options?: unknown }) => {
          void params;
          throw new Error('sync query construction failed');
        }) as unknown as ClaudeSdkQuery,
      );

      await expect(collectEvents(provider, 'Apply integration fixture tests.', { ...defaultOptions, timeout: 25_000 })).rejects.toMatchObject({
        code: 'CLAUDE_INTERNAL_ERROR',
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleans up timeout handles when sdk stream fails during iteration', async () => {
    vi.useFakeTimers();
    try {
      const provider = new ClaudeProvider(
        undefined,
        () => ({
          authMode: 'api_key',
          model: 'claude-3-7-sonnet-latest',
          apiKey: 'sk-test',
          apiKeySource: 'CLAUDE_API_KEY',
        }),
        ((params: { prompt: string | AsyncIterable<unknown>; options?: unknown }) => {
          void params;
          return (async function* () {
            yield {
              type: 'assistant',
              message: {
                content: [
                  {
                    type: 'text',
                    text: 'Partial output before failure.',
                  },
                ],
              },
            };
            throw new Error('stream failed during iteration');
          })();
        }) as unknown as ClaudeSdkQuery,
      );

      await expect(collectEvents(provider, 'Apply integration fixture tests.', { ...defaultOptions, timeout: 25_000 })).rejects.toMatchObject({
        code: 'CLAUDE_INTERNAL_ERROR',
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails deterministically when a partial fixture ends without a terminal result event', async () => {
    const provider = createProviderForFixture(sdkStreamFixtures.partial);

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CLAUDE_MISSING_RESULT',
    });
  });

  it('fails deterministically with typed invalid-event errors for malformed fixtures', async () => {
    const provider = createProviderForFixture(sdkStreamFixtures.malformed);

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CLAUDE_INVALID_EVENT',
      details: {
        fieldPath: 'event.usage.output_tokens',
      },
    });
  });

  it('classifies timeout-like failure fixtures into deterministic typed provider failures', async () => {
    const provider = createProviderForFixture(sdkStreamFixtures.failureTimeout);

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CLAUDE_TIMEOUT',
      retryable: true,
      details: {
        classification: 'timeout',
        retryable: true,
      },
    });
  });

  it('classifies non-timeout failure fixtures into deterministic internal provider failures', async () => {
    const provider = createProviderForFixture(sdkStreamFixtures.failureInternal);

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CLAUDE_INTERNAL_ERROR',
      details: {
        classification: 'internal',
      },
    });
  });

  it('classifies status-code 429 failure fixtures into deterministic rate-limit errors', async () => {
    const provider = createProviderForFixture(sdkStreamFixtures.failureRateLimitedStatus);

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CLAUDE_RATE_LIMITED',
      retryable: true,
      details: {
        classification: 'rate_limit',
        retryable: true,
        statusCode: 429,
      },
    });
  });

  it('classifies transport-code failure fixtures into deterministic transport errors', async () => {
    const provider = createProviderForFixture(sdkStreamFixtures.failureTransportCode);

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CLAUDE_TRANSPORT_ERROR',
      retryable: true,
      details: {
        classification: 'transport',
        retryable: true,
      },
    });
  });

  it('classifies assistant authentication failures into deterministic auth errors', async () => {
    const provider = createProviderForFixture([
      {
        type: 'assistant',
        error: 'authentication_failed',
      },
    ]);

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CLAUDE_AUTH_ERROR',
      details: {
        classification: 'auth',
        retryable: false,
      },
    });
  });
});
