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
      maxTokens: 512,
      timeout: 30_000,
    };

    const events = await collectEvents(provider, 'Implement adapter v1.', options);

    expect(events.map((event) => event.type)).toEqual(['system', 'result']);
    expect(capturedRequest).toBeDefined();
    expect(capturedRequest?.workingDirectory).toBe('/work/alphred');
    expect(capturedRequest?.systemPrompt).toBe('Be concise and deterministic.');
    expect(capturedRequest?.context).toEqual(['issue=13', 'provider=codex']);
    expect(capturedRequest?.maxTokens).toBe(512);
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

  it('throws a typed run failure when sdk emits turn.failed', async () => {
    const provider = new CodexProvider(
      undefined,
      () => createStreamingBootstrap([
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'turn.failed', error: { message: 'transport timeout' } },
      ]),
    );

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CODEX_RUN_FAILED',
      message: 'Codex turn failed: transport timeout',
    });
  });

  it('throws a typed run failure when sdk emits fatal stream errors', async () => {
    const provider = new CodexProvider(
      undefined,
      () => createStreamingBootstrap([
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'error', message: 'broken stream' },
      ]),
    );

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CODEX_RUN_FAILED',
      message: 'Codex stream emitted a fatal error: broken stream',
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

  it('wraps runner failures in the codex provider error path', async () => {
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
      expect(typedError.code).toBe('CODEX_RUN_FAILED');
      expect(typedError.cause).toBeInstanceOf(Error);
      expect((typedError.cause as Error).message).toBe('codex process crashed');
    }
  });

  it('fails fast with a typed configuration error when bootstrap validation fails', async () => {
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
      code: 'CODEX_INVALID_CONFIG',
      details: {
        bootstrapCode: 'CODEX_BOOTSTRAP_MISSING_AUTH',
      },
    });
  });

  it('fails fast with a deterministic configuration error when bootstrap throws an unknown error', async () => {
    const bootstrapFailure = new Error('socket timeout while probing runtime');
    const provider = new CodexProvider(
      createRunner([{ type: 'result', content: 'ok' }]),
      () => {
        throw bootstrapFailure;
      },
    );

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CODEX_INVALID_CONFIG',
      message: 'Codex provider bootstrap failed with an unknown configuration error.',
      cause: bootstrapFailure,
    });
  });
});
