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
  prompt = 'Implement issue #36 runtime tests.',
  options: ProviderRunOptions = defaultOptions,
): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of provider.run(prompt, options)) {
    events.push(event);
  }
  return events;
}

async function expectFixtureFailure(
  fixture: readonly unknown[],
  expected: Record<string, unknown>,
): Promise<void> {
  const provider = createProviderForFixture(fixture);
  await expect(collectEvents(provider)).rejects.toMatchObject(expected);
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
      metadata: {
        routingDecision: 'approved',
      },
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
  failureRateLimitedStatusString: [
    {
      type: 'result',
      subtype: 'error_during_execution',
      status: '429',
      errors: ['request failed'],
      usage: {
        input_tokens: 12,
        output_tokens: 3,
      },
    },
  ] as const,
  failureAuthStatusString: [
    {
      type: 'result',
      subtype: 'error_during_execution',
      status: '401',
      errors: ['request failed'],
      usage: {
        input_tokens: 12,
        output_tokens: 3,
      },
    },
  ] as const,
  failureBillingError: [
    {
      type: 'result',
      subtype: 'error_during_execution',
      errors: ['billing_error'],
      usage: {
        input_tokens: 12,
        output_tokens: 3,
      },
    },
  ] as const,
  failureMaxTurns: [
    {
      type: 'result',
      subtype: 'error_max_turns',
      errors: [],
      usage: {
        input_tokens: 12,
        output_tokens: 3,
      },
    },
  ] as const,
  failureMaxBudgetUsd: [
    {
      type: 'result',
      subtype: 'error_max_budget_usd',
      errors: [],
      usage: {
        input_tokens: 12,
        output_tokens: 3,
      },
    },
  ] as const,
  failureMaxStructuredOutputRetries: [
    {
      type: 'result',
      subtype: 'error_max_structured_output_retries',
      errors: [],
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
  failureTimeoutCodeEtimedout: [
    {
      type: 'result',
      subtype: 'error_during_execution',
      errors: ['request failed'],
      error: {
        code: 'ETIMEDOUT',
        message: 'connect ETIMEDOUT 1.2.3.4:443',
      },
      usage: {
        input_tokens: 12,
        output_tokens: 3,
      },
    },
  ] as const,
};

// Coverage boundary:
// - This file validates fixture-driven Claude SDK stream contracts.
// - claude.test.ts validates broader provider behavior and mixed event paths.
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
    expect(events[5]?.metadata).toMatchObject({
      routingDecision: 'approved',
    });
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

  it('fails deterministically when assistant content includes unsupported block types', async () => {
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

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CLAUDE_INVALID_EVENT',
      details: {
        blockType: 'image',
        blockPath: 'event.message.content[0]',
      },
    });
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

  it('falls back to concatenated assistant text when success result omits result content', async () => {
    const provider = createProviderForFixture([
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: 'Alpha',
            },
            {
              type: 'text',
              text: 'Beta',
            },
          ],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        usage: {
          input_tokens: 9,
          output_tokens: 5,
        },
      },
    ]);

    const events = await collectEvents(provider);
    expect(events.map((event) => event.type)).toEqual(['system', 'assistant', 'assistant', 'usage', 'result']);
    expect(events[1]?.content).toBe('Alpha');
    expect(events[2]?.content).toBe('Beta');
    expect(events[4]?.content).toBe('AlphaBeta');
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

  it.each([
    [
      'classifies timeout-like failure fixtures into deterministic typed provider failures',
      sdkStreamFixtures.failureTimeout,
      {
        code: 'CLAUDE_TIMEOUT',
        retryable: true,
        message: 'Claude run failed: transport timeout',
        details: {
          classification: 'timeout',
          retryable: true,
        },
      },
    ],
    [
      'classifies non-timeout failure fixtures into deterministic internal provider failures',
      sdkStreamFixtures.failureInternal,
      {
        code: 'CLAUDE_INTERNAL_ERROR',
        message: 'Claude run failed: Sample rate mismatch in audio parser',
        details: {
          classification: 'internal',
        },
      },
    ],
    [
      'classifies status-code 429 failure fixtures into deterministic rate-limit errors',
      sdkStreamFixtures.failureRateLimitedStatus,
      {
        code: 'CLAUDE_RATE_LIMITED',
        retryable: true,
        message: 'Claude run failed: quota exceeded for this workspace',
        details: {
          classification: 'rate_limit',
          retryable: true,
          statusCode: 429,
        },
      },
    ],
    [
      'classifies string status-code 429 failure fixtures into deterministic rate-limit errors',
      sdkStreamFixtures.failureRateLimitedStatusString,
      {
        code: 'CLAUDE_RATE_LIMITED',
        retryable: true,
        message: 'Claude run failed: request failed',
        details: {
          classification: 'rate_limit',
          retryable: true,
          statusCode: 429,
        },
      },
    ],
    [
      'classifies string status-code 401 failure fixtures into deterministic auth errors',
      sdkStreamFixtures.failureAuthStatusString,
      {
        code: 'CLAUDE_AUTH_ERROR',
        retryable: false,
        message: 'Claude run failed: request failed',
        details: {
          classification: 'auth',
          retryable: false,
          statusCode: 401,
        },
      },
    ],
  ] as const)('%s', async (_title, fixture, expected) => {
    await expectFixtureFailure(fixture, expected);
  });

  it('uses a deterministic fallback failure message when result failures omit error text', async () => {
    await expectFixtureFailure(sdkStreamFixtures.failureMaxTurns, {
      code: 'CLAUDE_INTERNAL_ERROR',
      retryable: false,
      message: 'Claude run failed: Claude reported a terminal result failure with subtype "error_max_turns".',
      details: {
        subtype: 'error_max_turns',
        errors: [],
        classification: 'internal',
        retryable: false,
      },
    });
  });

  it('prioritizes auth classification over rate-limit wording when status is forbidden', async () => {
    const provider = createProviderForFixture([
      {
        type: 'result',
        subtype: 'error_during_execution',
        status: 403,
        errors: ['rate limit exceeded while validating credentials'],
        usage: {
          input_tokens: 12,
          output_tokens: 3,
        },
      },
    ]);

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CLAUDE_AUTH_ERROR',
      retryable: false,
      details: {
        classification: 'auth',
        retryable: false,
        statusCode: 403,
      },
    });
  });

  it('prioritizes rate-limit classification over timeout wording when status is 429', async () => {
    const provider = createProviderForFixture([
      {
        type: 'result',
        subtype: 'error_during_execution',
        status: 429,
        errors: ['request timed out while waiting for retry slot'],
        usage: {
          input_tokens: 12,
          output_tokens: 3,
        },
      },
    ]);

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

  it('prioritizes timeout classification over transport-code wording when status is 408', async () => {
    const provider = createProviderForFixture([
      {
        type: 'result',
        subtype: 'error_during_execution',
        status: 408,
        errors: ['connection reset by peer'],
        error: {
          code: 'ECONNRESET',
          message: 'connection reset by peer',
        },
        usage: {
          input_tokens: 12,
          output_tokens: 3,
        },
      },
    ]);

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CLAUDE_TIMEOUT',
      retryable: true,
      details: {
        classification: 'timeout',
        retryable: true,
        statusCode: 408,
        failureCode: 'ECONNRESET',
      },
    });
  });

  it('classifies billing_error result failures as deterministic non-retryable auth errors', async () => {
    const provider = createProviderForFixture(sdkStreamFixtures.failureBillingError);

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CLAUDE_AUTH_ERROR',
      retryable: false,
      details: {
        classification: 'auth',
        retryable: false,
      },
    });
  });

  it.each([
    ['error_max_turns', sdkStreamFixtures.failureMaxTurns],
    ['error_max_budget_usd', sdkStreamFixtures.failureMaxBudgetUsd],
    ['error_max_structured_output_retries', sdkStreamFixtures.failureMaxStructuredOutputRetries],
  ] as const)(
    'classifies result subtype %s as deterministic non-retryable internal errors',
    async (_subtype, fixture) => {
      const provider = createProviderForFixture(fixture);

      await expect(collectEvents(provider)).rejects.toMatchObject({
        code: 'CLAUDE_INTERNAL_ERROR',
        retryable: false,
        details: {
          classification: 'internal',
          retryable: false,
        },
      });
    },
  );

  it('classifies transport-code failure fixtures into deterministic transport errors', async () => {
    const provider = createProviderForFixture(sdkStreamFixtures.failureTransportCode);

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CLAUDE_TRANSPORT_ERROR',
      retryable: true,
      details: {
        classification: 'transport',
        retryable: true,
        failureCode: 'ECONNRESET',
      },
    });
  });

  it('classifies ETIMEDOUT code failure fixtures into deterministic timeout errors', async () => {
    const provider = createProviderForFixture(sdkStreamFixtures.failureTimeoutCodeEtimedout);

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CLAUDE_TIMEOUT',
      retryable: true,
      details: {
        classification: 'timeout',
        retryable: true,
        failureCode: 'ETIMEDOUT',
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

  it('classifies auth_status message errors into deterministic auth errors', async () => {
    const provider = createProviderForFixture([
      {
        type: 'auth_status',
        isAuthenticating: false,
        output: ['Authentication failed'],
        error: 'authentication_failed',
      },
    ]);

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CLAUDE_AUTH_ERROR',
      details: {
        classification: 'auth',
        retryable: false,
        authStatusError: 'authentication_failed',
      },
    });
  });

  it('classifies assistant server_error failures as retryable internal errors', async () => {
    const provider = createProviderForFixture([
      {
        type: 'assistant',
        error: 'server_error',
      },
    ]);

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CLAUDE_INTERNAL_ERROR',
      retryable: true,
      details: {
        classification: 'internal',
        retryable: true,
      },
    });
  });

  it('classifies assistant billing_error failures as deterministic non-retryable auth errors', async () => {
    const provider = createProviderForFixture([
      {
        type: 'assistant',
        error: 'billing_error',
      },
    ]);

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CLAUDE_AUTH_ERROR',
      retryable: false,
      details: {
        classification: 'auth',
        retryable: false,
      },
    });
  });
});
