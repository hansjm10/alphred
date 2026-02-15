import type { ProviderEvent, ProviderRunOptions } from '@alphred/shared';
import type { Codex } from '@openai/codex-sdk';
import { describe, expect, it } from 'vitest';
import {
  CodexProvider,
  CodexProviderError,
  type CodexBootstrapper,
  type CodexRawEvent,
  type CodexRunRequest,
} from './codex.js';
import { CodexBootstrapError, type CodexSdkBootstrap } from './codexSdkBootstrap.js';

const defaultOptions: ProviderRunOptions = {
  workingDirectory: '/tmp/alphred-codex-test',
};

function createRunner(events: readonly CodexRawEvent[]): (request: CodexRunRequest) => AsyncIterable<CodexRawEvent> {
  return async function* (_request: CodexRunRequest): AsyncIterable<CodexRawEvent> {
    for (const event of events) {
      yield event;
    }
  };
}

function createNoopBootstrap(): CodexSdkBootstrap {
  return {
    client: {} as Codex,
    authMode: 'api_key',
    model: 'gpt-5-codex',
    apiKey: 'sk-test',
    codexHome: '/tmp/.codex',
    codexBinaryPath: '/tmp/codex',
  };
}

const noopBootstrap: CodexBootstrapper = () => createNoopBootstrap();

type RunnerFn = (request: CodexRunRequest) => AsyncIterable<CodexRawEvent>;

function createProvider(runner: RunnerFn) {
  return new CodexProvider(runner, noopBootstrap);
}

type CapturedSdkInvocation = {
  threadOptions?: unknown;
  input?: unknown;
  turnOptions?: unknown;
};

function createMockSdkClient(events: readonly unknown[], capture?: CapturedSdkInvocation): Codex {
  return {
    startThread: (threadOptions?: unknown) => {
      if (capture) {
        capture.threadOptions = threadOptions;
      }

      return {
        runStreamed: async (input: unknown, turnOptions?: unknown) => {
          if (capture) {
            capture.input = input;
            capture.turnOptions = turnOptions;
          }

          return {
            events: (async function* () {
              for (const event of events) {
                yield event;
              }
            })(),
          };
        },
      };
    },
  } as unknown as Codex;
}

function createStreamingBootstrap(events: readonly unknown[], capture?: CapturedSdkInvocation): CodexSdkBootstrap {
  return {
    ...createNoopBootstrap(),
    client: createMockSdkClient(events, capture),
  };
}

async function collectEvents(
  provider: CodexProvider,
  prompt = 'Implement the requested change.',
  options: ProviderRunOptions = defaultOptions,
): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];

  for await (const event of provider.run(prompt, options)) {
    events.push(event);
  }

  return events;
}

describe('codex provider', () => {
  it('emits a normalized provider event stream with a deterministic sequence', async () => {
    const provider = createProvider(
      createRunner([
        { type: 'message', content: 'Drafting implementation.' },
        { type: 'usage', metadata: { inputTokens: 12, outputTokens: 5 } },
        { type: 'final', content: 'Implemented and validated.' },
      ]),
    );

    const events = await collectEvents(provider);

    expect(events.map((event) => event.type)).toEqual(['system', 'assistant', 'usage', 'result']);
    expect(events[0].metadata).toMatchObject({
      provider: 'codex',
      workingDirectory: defaultOptions.workingDirectory,
      hasSystemPrompt: false,
      contextItemCount: 0,
    });
    expect(events[1].content).toBe('Drafting implementation.');
    expect(events[2].metadata).toMatchObject({
      input_tokens: 12,
      output_tokens: 5,
      total_tokens: 17,
      usage: {
        input_tokens: 12,
        output_tokens: 5,
        total_tokens: 17,
      },
    });
    expect(events[3].content).toBe('Implemented and validated.');
  });

  it('keeps incremental tokens metadata without coercing it to total_tokens', async () => {
    const provider = createProvider(
      createRunner([
        { type: 'usage', metadata: { tokens: 30 } },
        { type: 'result', content: 'done' },
      ]),
    );

    const events = await collectEvents(provider);

    expect(events.map((event) => event.type)).toEqual(['system', 'usage', 'result']);
    expect(events[1].metadata).toEqual({ tokens: 30 });
  });

  it('preserves structured routingDecision metadata on result events', async () => {
    const provider = createProvider(
      createRunner([
        {
          type: 'result',
          content: 'done',
          metadata: { routingDecision: 'approved' },
        },
      ]),
    );

    const events = await collectEvents(provider);

    expect(events.map((event) => event.type)).toEqual(['system', 'result']);
    expect(events[1].metadata).toMatchObject({ routingDecision: 'approved' });
  });

  it('preserves nested cumulative usage when top-level tokens metadata is incremental', async () => {
    const provider = createProvider(
      createRunner([
        { type: 'usage', metadata: { tokens: 5, usage: { total_tokens: 40 } } },
        { type: 'result', content: 'done' },
      ]),
    );

    const events = await collectEvents(provider);

    expect(events.map((event) => event.type)).toEqual(['system', 'usage', 'result']);
    expect(events[1].metadata).toMatchObject({
      tokens: 5,
      total_tokens: 40,
      usage: {
        total_tokens: 40,
      },
    });
  });

  it('normalizes nested tokensUsed usage metadata into total_tokens', async () => {
    const provider = createProvider(
      createRunner([
        { type: 'usage', metadata: { tokens: 5, usage: { tokensUsed: 40 } } },
        { type: 'result', content: 'done' },
      ]),
    );

    const events = await collectEvents(provider);

    expect(events.map((event) => event.type)).toEqual(['system', 'usage', 'result']);
    expect(events[1].metadata).toMatchObject({
      tokens: 5,
      total_tokens: 40,
      usage: {
        total_tokens: 40,
      },
    });
  });

  it('bridges working directory and prompt options into the codex runner request', async () => {
    let capturedRequest: CodexRunRequest | undefined;
    const provider = createProvider(async function* (request: CodexRunRequest): AsyncIterable<CodexRawEvent> {
      capturedRequest = request;
      yield { type: 'result', content: 'ok' };
    });

    const options: ProviderRunOptions = {
      workingDirectory: '/work/alphred',
      systemPrompt: 'Be concise and deterministic.',
      context: ['issue=13', 'provider=codex'],
      timeout: 30_000,
    };

    const events = await collectEvents(provider, 'Implement adapter v1.', options);

    expect(events.map((event) => event.type)).toEqual(['system', 'result']);
    expect(capturedRequest).toBeDefined();
    expect(capturedRequest?.workingDirectory).toBe('/work/alphred');
    expect(capturedRequest?.systemPrompt).toBe('Be concise and deterministic.');
    expect(capturedRequest?.context).toEqual(['issue=13', 'provider=codex']);
    expect(capturedRequest?.timeout).toBe(30_000);
    expect(capturedRequest?.bridgedPrompt).toContain('System prompt:\nBe concise and deterministic.');
    expect(capturedRequest?.bridgedPrompt).toContain('Context:\n[1] issue=13\n[2] provider=codex');
    expect(capturedRequest?.bridgedPrompt).toContain('User prompt:\nImplement adapter v1.');
  });

  it('maps the default codex sdk stream into ordered provider events', async () => {
    const capture: CapturedSdkInvocation = {};
    const provider = new CodexProvider(
      undefined,
      () => createStreamingBootstrap([
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'turn.started' },
        {
          type: 'item.started',
          item: {
            id: 'cmd-1',
            type: 'command_execution',
            command: 'pnpm test',
            aggregated_output: '',
            status: 'in_progress',
          },
        },
        {
          type: 'item.completed',
          item: {
            id: 'cmd-1',
            type: 'command_execution',
            command: 'pnpm test',
            aggregated_output: 'all good',
            status: 'completed',
            exit_code: 0,
          },
        },
        {
          type: 'item.completed',
          item: {
            id: 'msg-1',
            type: 'agent_message',
            text: 'Implemented and validated.',
          },
        },
        {
          type: 'turn.completed',
          usage: {
            input_tokens: 12,
            cached_input_tokens: 2,
            output_tokens: 5,
          },
        },
      ], capture),
    );

    const events = await collectEvents(provider, 'Implement adapter v2.', {
      workingDirectory: '/work/alphred',
      timeout: 25_000,
    });

    expect(events.map((event) => event.type)).toEqual(['system', 'tool_use', 'tool_result', 'assistant', 'usage', 'result']);
    expect(events[5].content).toBe('Implemented and validated.');
    expect(events[4].metadata).toMatchObject({
      input_tokens: 12,
      output_tokens: 5,
      total_tokens: 17,
      usage: {
        input_tokens: 12,
        output_tokens: 5,
        total_tokens: 17,
      },
    });
    expect(capture.threadOptions).toEqual({
      model: 'gpt-5-codex',
      workingDirectory: '/work/alphred',
    });
    expect(capture.input).toBe('Implement adapter v2.');
    expect(capture.turnOptions).toMatchObject({
      signal: expect.any(AbortSignal),
    });
  });

  it('maps a realistic mixed codex stream including tool lifecycles and non-terminal updates', async () => {
    const capture: CapturedSdkInvocation = {};
    const provider = new CodexProvider(
      undefined,
      () => createStreamingBootstrap([
        { type: 'thread.started', thread_id: 'thread-real-world-1' },
        { type: 'turn.started' },
        {
          type: 'item.started',
          item: {
            id: 'cmd-1',
            type: 'command_execution',
            command: 'pnpm lint',
          },
        },
        {
          type: 'item.updated',
          item: {
            id: 'cmd-1',
            type: 'command_execution',
            command: 'pnpm lint',
            status: 'in_progress',
          },
        },
        {
          type: 'item.completed',
          item: {
            id: 'cmd-1',
            type: 'command_execution',
            command: 'pnpm lint',
            exit_code: 0,
          },
        },
        {
          type: 'item.started',
          item: {
            id: 'mcp-1',
            type: 'mcp_tool_call',
            server: 'github',
            tool: 'search_issues',
          },
        },
        {
          type: 'item.completed',
          item: {
            id: 'mcp-1',
            type: 'mcp_tool_call',
            server: 'github',
            tool: 'search_issues',
            result: { total: 2 },
          },
        },
        {
          type: 'item.started',
          item: {
            id: 99,
            type: 'web_search',
            query: 'vitest coverage thresholds',
          },
        },
        {
          type: 'item.completed',
          item: {
            id: 99,
            type: 'web_search',
            query: 'vitest coverage thresholds',
          },
        },
        {
          type: 'item.started',
          item: {
            id: 'file-1',
            type: 'file_change',
            changes: [{ path: 'packages/agents/src/providers/codex.test.ts' }],
          },
        },
        {
          type: 'item.completed',
          item: {
            id: 'file-1',
            type: 'file_change',
            changes: [{ path: 'packages/agents/src/providers/codex.test.ts' }],
          },
        },
        {
          type: 'item.started',
          item: {
            id: 'todo-1',
            type: 'todo_list',
            items: [{ content: 'add edge-case tests', status: 'in_progress' }],
          },
        },
        {
          type: 'item.completed',
          item: {
            id: 'todo-1',
            type: 'todo_list',
            items: [{ content: 'add edge-case tests', status: 'completed' }],
          },
        },
        {
          type: 'item.started',
          item: {
            id: 'reasoning-1',
            type: 'reasoning',
            text: 'Inspecting provider branch coverage.',
          },
        },
        {
          type: 'item.completed',
          item: {
            id: 'reasoning-1',
            type: 'reasoning',
            text: 'Need to exercise more tool item variants.',
          },
        },
        {
          type: 'item.started',
          item: {
            id: 'error-1',
            type: 'error',
            message: 'Transient tool retry.',
          },
        },
        {
          type: 'item.completed',
          item: {
            id: 'error-1',
            type: 'error',
            message: 'Transient tool retry.',
          },
        },
        {
          type: 'item.completed',
          item: {
            id: 'msg-1',
            type: 'agent_message',
            text: 'All checks passed and changes were applied.',
          },
        },
        {
          type: 'turn.completed',
          usage: {
            input_tokens: 42,
            cached_input_tokens: 6,
            output_tokens: 9,
          },
        },
      ], capture),
    );

    const events = await collectEvents(provider, 'Harden codex edge-case tests.', {
      workingDirectory: '/work/alphred',
    });

    expect(events.map((event) => event.type)).toEqual([
      'system',
      'tool_use',
      'tool_result',
      'tool_use',
      'tool_result',
      'tool_use',
      'tool_result',
      'tool_use',
      'tool_result',
      'tool_use',
      'tool_result',
      'system',
      'system',
      'assistant',
      'usage',
      'result',
    ]);
    expect(events[1].content).toBe('pnpm lint');
    expect(JSON.parse(events[2].content)).toMatchObject({
      command: 'pnpm lint',
      output: '',
      exit_code: 0,
    });
    expect(events[3].content).toBe('github.search_issues');
    expect(JSON.parse(events[4].content)).toMatchObject({
      server: 'github',
      tool: 'search_issues',
      result: { total: 2 },
    });
    expect(events[5].content).toBe('vitest coverage thresholds');
    expect(JSON.parse(events[6].content)).toEqual({ query: 'vitest coverage thresholds' });
    expect((events[5].metadata as Record<string, unknown>).itemId).toBeUndefined();
    expect(events[7].content).toBe('file_change:1');
    expect(JSON.parse(events[8].content)).toEqual([{ path: 'packages/agents/src/providers/codex.test.ts' }]);
    expect(events[9].content).toBe('todo_list');
    expect(JSON.parse(events[10].content)).toEqual([{ content: 'add edge-case tests', status: 'completed' }]);
    expect(events[11].content).toBe('Need to exercise more tool item variants.');
    expect(events[12].content).toBe('Transient tool retry.');
    expect(events[13].content).toBe('All checks passed and changes were applied.');
    expect(events[15].content).toBe('All checks passed and changes were applied.');
    expect(capture.turnOptions).toBeUndefined();
  });

  it('throws a typed error when sdk stream emits malformed items', async () => {
    const provider = new CodexProvider(
      undefined,
      () => createStreamingBootstrap([
        { type: 'thread.started', thread_id: 'thread-1' },
        {
          type: 'item.completed',
          item: {
            id: 'msg-1',
            type: 'agent_message',
          },
        },
      ]),
    );

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CODEX_INVALID_EVENT',
    });
  });

  it('throws a typed invalid-event error when sdk emits malformed event payloads', async () => {
    const provider = new CodexProvider(
      undefined,
      () => createStreamingBootstrap([
        [],
      ]),
    );

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CODEX_INVALID_EVENT',
      details: {
        fieldPath: 'event',
      },
    });
  });

  it('throws a typed invalid-event error when sdk emits unsupported item lifecycle payloads', async () => {
    const provider = new CodexProvider(
      undefined,
      () => createStreamingBootstrap([
        { type: 'thread.started', thread_id: 'thread-1' },
        {
          type: 'item.started',
          item: {
            id: 'unknown-1',
            type: 'unknown_tool_type',
          },
        },
      ]),
    );

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CODEX_INVALID_EVENT',
      details: {
        itemType: 'unknown_tool_type',
      },
    });
  });

  it('throws a typed invalid-event error when sdk usage token counts are invalid', async () => {
    const provider = new CodexProvider(
      undefined,
      () => createStreamingBootstrap([
        { type: 'thread.started', thread_id: 'thread-1' },
        {
          type: 'item.completed',
          item: {
            id: 'msg-1',
            type: 'agent_message',
            text: 'Done.',
          },
        },
        {
          type: 'turn.completed',
          usage: {
            input_tokens: 10,
            cached_input_tokens: -1,
            output_tokens: 3,
          },
        },
      ]),
    );

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CODEX_INVALID_EVENT',
      details: {
        fieldPath: 'event.usage.cached_input_tokens',
      },
    });
  });

  it('throws a typed invalid-event error when sdk emits unsupported stream event types', async () => {
    const provider = new CodexProvider(
      undefined,
      () => createStreamingBootstrap([
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'turn.cancelled' },
      ]),
    );

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CODEX_INVALID_EVENT',
      details: {
        eventType: 'turn.cancelled',
      },
    });
  });

  it('classifies timeout failures from sdk turn.failed as retryable timeout errors', async () => {
    const provider = new CodexProvider(
      undefined,
      () => createStreamingBootstrap([
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'turn.failed', error: { message: 'transport timeout' } },
      ]),
    );

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CODEX_TIMEOUT',
      message: 'Codex turn failed: transport timeout',
      retryable: true,
      details: {
        classification: 'timeout',
        retryable: true,
      },
    });
  });

  it('classifies rate-limited sdk failures as retryable rate-limit errors', async () => {
    const provider = new CodexProvider(
      undefined,
      () => createStreamingBootstrap([
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'turn.failed', error: { message: 'Too many requests', status: 429, code: 'rate_limit_exceeded' } },
      ]),
    );

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CODEX_RATE_LIMITED',
      retryable: true,
      details: {
        classification: 'rate_limit',
        retryable: true,
        statusCode: 429,
        failureCode: 'rate_limit_exceeded',
      },
    });
  });

  it('classifies throttled sdk failures as retryable rate-limit errors', async () => {
    const provider = new CodexProvider(
      undefined,
      () => createStreamingBootstrap([
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'turn.failed', error: { message: 'Request throttled by upstream gateway' } },
      ]),
    );

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CODEX_RATE_LIMITED',
      retryable: true,
      details: {
        classification: 'rate_limit',
        retryable: true,
      },
    });
  });

  it('prioritizes auth classification over rate-limit wording when status is forbidden', async () => {
    const provider = new CodexProvider(
      undefined,
      () => createStreamingBootstrap([
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'turn.failed', error: { message: 'quota exceeded while authenticating request', status: 403 } },
      ]),
    );

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CODEX_AUTH_ERROR',
      retryable: false,
      details: {
        classification: 'auth',
        retryable: false,
        statusCode: 403,
      },
    });
  });

  it('classifies common rate-limit phrases as retryable rate-limit errors', async () => {
    const rateLimitMessages = [
      'Rate limit exceeded for this model',
      'Request is rate-limited, retry later',
      'API quota exceeded',
      'Client is throttling requests',
      'Slow down and try again',
    ];

    for (const message of rateLimitMessages) {
      const provider = new CodexProvider(
        undefined,
        () => createStreamingBootstrap([
          { type: 'thread.started', thread_id: 'thread-1' },
          { type: 'turn.failed', error: { message } },
        ]),
      );

      await expect(collectEvents(provider)).rejects.toMatchObject({
        code: 'CODEX_RATE_LIMITED',
        retryable: true,
        details: {
          classification: 'rate_limit',
          retryable: true,
        },
      });
    }
  });

  it('does not classify unrelated rate wording as a rate-limit error', async () => {
    const provider = new CodexProvider(
      undefined,
      () => createStreamingBootstrap([
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'turn.failed', error: { message: 'Sample rate mismatch in audio parser' } },
      ]),
    );

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CODEX_INTERNAL_ERROR',
      retryable: false,
      details: {
        classification: 'internal',
        retryable: false,
      },
    });
  });

  it('classifies ETIMEDOUT sdk failures as retryable timeout errors', async () => {
    const provider = new CodexProvider(
      undefined,
      () => createStreamingBootstrap([
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'turn.failed', error: { message: 'Request failed', code: 'ETIMEDOUT' } },
      ]),
    );

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CODEX_TIMEOUT',
      retryable: true,
      details: {
        classification: 'timeout',
        retryable: true,
        failureCode: 'ETIMEDOUT',
      },
    });
  });

  it('classifies transport sdk failures as retryable transport errors', async () => {
    const provider = new CodexProvider(
      undefined,
      () => createStreamingBootstrap([
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'error', message: 'socket hang up' },
      ]),
    );

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CODEX_TRANSPORT_ERROR',
      message: 'Codex stream emitted a fatal error: socket hang up',
      retryable: true,
      details: {
        classification: 'transport',
        retryable: true,
      },
    });
  });

  it('classifies non-specific fatal sdk errors as internal failures', async () => {
    const provider = new CodexProvider(
      undefined,
      () => createStreamingBootstrap([
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'error', message: 'broken stream' },
      ]),
    );

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CODEX_INTERNAL_ERROR',
      message: 'Codex stream emitted a fatal error: broken stream',
      retryable: false,
      details: {
        classification: 'internal',
        retryable: false,
      },
    });
  });

  it('classifies 5xx sdk failures as retryable internal errors', async () => {
    const provider = new CodexProvider(
      undefined,
      () => createStreamingBootstrap([
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'turn.failed', error: { message: 'Upstream service failed', status: 503, code: 'server_error' } },
      ]),
    );

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CODEX_INTERNAL_ERROR',
      retryable: true,
      details: {
        classification: 'internal',
        retryable: true,
        statusCode: 503,
        failureCode: 'server_error',
      },
    });
  });

  it('throws a typed invalid-event error when sdk emits events after turn completion', async () => {
    const provider = new CodexProvider(
      undefined,
      () => createStreamingBootstrap([
        {
          type: 'item.completed',
          item: {
            id: 'msg-1',
            type: 'agent_message',
            text: 'final answer',
          },
        },
        {
          type: 'turn.completed',
          usage: {
            input_tokens: 10,
            cached_input_tokens: 0,
            output_tokens: 3,
          },
        },
        {
          type: 'item.completed',
          item: {
            id: 'cmd-2',
            type: 'command_execution',
            command: 'echo done',
            aggregated_output: 'done',
            status: 'completed',
            exit_code: 0,
          },
        },
      ]),
    );

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CODEX_INVALID_EVENT',
    });
  });

  it('normalizes circular event content without default object stringification', async () => {
    const circularContent: Record<string, unknown> = { step: 'drafting' };
    circularContent.self = circularContent;
    const provider = createProvider(
      createRunner([
        { type: 'assistant', content: circularContent },
        { type: 'result', content: 'done' },
      ]),
    );

    const events = await collectEvents(provider);

    expect(events.map((event) => event.type)).toEqual(['system', 'assistant', 'result']);
    expect(events[1].content).not.toBe('[object Object]');
    expect(events[1].content).toContain('step');
  });

  it('throws a typed error when required options are invalid', async () => {
    const provider = createProvider(createRunner([{ type: 'result', content: '' }]));
    const invalidOptions = [
      { workingDirectory: '   ' },
      {},
      { workingDirectory: 123 },
      null,
    ];

    for (const options of invalidOptions) {
      await expect(collectEvents(provider, 'prompt', options as unknown as ProviderRunOptions)).rejects.toMatchObject({
        code: 'CODEX_INVALID_OPTIONS',
      });
    }

    await expect(
      (async () => {
        for await (const event of provider.run('prompt', undefined as unknown as ProviderRunOptions)) {
          void event;
        }
      })(),
    ).rejects.toMatchObject({
      code: 'CODEX_INVALID_OPTIONS',
    });
  });

  it('throws a typed error when optional options are malformed', async () => {
    const provider = createProvider(createRunner([{ type: 'result', content: '' }]));
    const invalidOptionalOptions = [
      { workingDirectory: '/tmp/alphred-codex-test', context: 'invalid-context' },
      { workingDirectory: '/tmp/alphred-codex-test', context: null },
      { workingDirectory: '/tmp/alphred-codex-test', systemPrompt: 42 },
      { workingDirectory: '/tmp/alphred-codex-test', systemPrompt: { text: 'be concise' } },
      { workingDirectory: '/tmp/alphred-codex-test', timeout: 3_000_000_000 },
      { workingDirectory: '/tmp/alphred-codex-test', timeout: Number.MAX_SAFE_INTEGER },
    ];

    for (const options of invalidOptionalOptions) {
      await expect(collectEvents(provider, 'prompt', options as unknown as ProviderRunOptions)).rejects.toMatchObject({
        code: 'CODEX_INVALID_OPTIONS',
      });
    }
  });

  it('throws a typed error when codex emits unsupported event types', async () => {
    const provider = createProvider(createRunner([{ type: 'unsupported' }]));

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CODEX_INVALID_EVENT',
    });
  });

  it('throws a typed error when codex emits events after result', async () => {
    const provider = createProvider(
      createRunner([
        { type: 'result', content: 'done' },
        { type: 'usage', metadata: { tokens: 1 } },
      ]),
    );

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CODEX_INVALID_EVENT',
    });
  });

  it('throws a typed error when codex completes without a result event', async () => {
    const provider = createProvider(createRunner([{ type: 'assistant', content: 'partial output' }]));

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CODEX_MISSING_RESULT',
    });
  });

  it('maps generic runner failures to internal non-retryable errors', async () => {
    const provider = createProvider(async function* (_request: CodexRunRequest): AsyncIterable<CodexRawEvent> {
      throw new Error('codex process crashed');
      yield { type: 'result', content: '' };
    });

    try {
      await collectEvents(provider);
      throw new Error('Expected provider run to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(CodexProviderError);

      const typedError = error as CodexProviderError;
      expect(typedError.code).toBe('CODEX_INTERNAL_ERROR');
      expect(typedError.retryable).toBe(false);
      expect(typedError.details).toMatchObject({
        classification: 'internal',
        retryable: false,
      });
      expect(typedError.cause).toBeInstanceOf(Error);
      expect((typedError.cause as Error).message).toBe('codex process crashed');
    }
  });

  it('maps runner transport failures to retryable transport errors', async () => {
    const provider = createProvider(async function* (_request: CodexRunRequest): AsyncIterable<CodexRawEvent> {
      const transportError = new Error('socket reset while reading stream') as Error & { code: string };
      transportError.code = 'ECONNRESET';
      throw transportError;
      yield { type: 'result', content: '' };
    });

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CODEX_TRANSPORT_ERROR',
      retryable: true,
      details: {
        classification: 'transport',
        retryable: true,
        failureCode: 'ECONNRESET',
      },
    });
  });

  it('fails fast with a typed auth error when bootstrap detects missing auth', async () => {
    const provider = new CodexProvider(
      createRunner([{ type: 'result', content: 'ok' }]),
      () => {
        throw new CodexBootstrapError(
          'CODEX_BOOTSTRAP_MISSING_AUTH',
          'Codex provider requires either an API key or an existing Codex CLI login session.',
        );
      },
    );

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CODEX_AUTH_ERROR',
      details: {
        bootstrapCode: 'CODEX_BOOTSTRAP_MISSING_AUTH',
        classification: 'auth',
        retryable: false,
      },
      retryable: false,
    });
  });

  it('maps deterministic bootstrap config failures to non-retryable config errors', async () => {
    const provider = new CodexProvider(
      createRunner([{ type: 'result', content: 'ok' }]),
      () => {
        throw new CodexBootstrapError(
          'CODEX_BOOTSTRAP_INVALID_CONFIG',
          'Codex provider requires OPENAI_BASE_URL to be a valid URL when set.',
          { envKey: 'OPENAI_BASE_URL' },
        );
      },
    );

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CODEX_INVALID_CONFIG',
      details: {
        bootstrapCode: 'CODEX_BOOTSTRAP_INVALID_CONFIG',
        classification: 'config',
        retryable: false,
        envKey: 'OPENAI_BASE_URL',
      },
    });
  });

  it('maps bootstrap session-check failures to non-retryable config errors', async () => {
    const provider = new CodexProvider(
      createRunner([{ type: 'result', content: 'ok' }]),
      () => {
        throw new CodexBootstrapError(
          'CODEX_BOOTSTRAP_SESSION_CHECK_FAILED',
          'Codex provider could not verify Codex CLI login status.',
          { codexHome: '/tmp/.codex', message: 'spawn EACCES' },
        );
      },
    );

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CODEX_INVALID_CONFIG',
      retryable: false,
      details: {
        bootstrapCode: 'CODEX_BOOTSTRAP_SESSION_CHECK_FAILED',
        classification: 'config',
        retryable: false,
        codexHome: '/tmp/.codex',
        message: 'spawn EACCES',
      },
    });
  });

  it('maps bootstrap client init failures to non-retryable internal errors', async () => {
    const bootstrapCause = new Error('SDK client constructor threw');
    const provider = new CodexProvider(
      createRunner([{ type: 'result', content: 'ok' }]),
      () => {
        throw new CodexBootstrapError(
          'CODEX_BOOTSTRAP_CLIENT_INIT_FAILED',
          'Codex provider failed to initialize the Codex SDK client.',
          { codexPath: '/tmp/codex' },
          bootstrapCause,
        );
      },
    );

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CODEX_INTERNAL_ERROR',
      retryable: false,
      details: {
        bootstrapCode: 'CODEX_BOOTSTRAP_CLIENT_INIT_FAILED',
        classification: 'internal',
        retryable: false,
        codexPath: '/tmp/codex',
      },
      cause: bootstrapCause,
    });
  });

  it('fails fast with a deterministic internal error when bootstrap throws an unknown error', async () => {
    const bootstrapFailure = new Error('socket timeout while probing runtime');
    const provider = new CodexProvider(
      createRunner([{ type: 'result', content: 'ok' }]),
      () => {
        throw bootstrapFailure;
      },
    );

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CODEX_INTERNAL_ERROR',
      message: 'Codex provider bootstrap failed with an unknown internal error.',
      retryable: false,
      details: {
        classification: 'internal',
        retryable: false,
      },
      cause: bootstrapFailure,
    });
  });
});
