import type { ProviderEvent, ProviderRunOptions } from '@alphred/shared';
import { describe, expect, it } from 'vitest';
import {
  ClaudeProvider,
  ClaudeProviderError,
  type ClaudeBootstrapper,
  type ClaudeRawEvent,
  type ClaudeRunRequest,
} from './claude.js';
import { ClaudeBootstrapError } from './claudeSdkBootstrap.js';

const defaultOptions: ProviderRunOptions = {
  workingDirectory: '/tmp/alphred-claude-test',
};

function createRunner(events: readonly ClaudeRawEvent[]): (request: ClaudeRunRequest) => AsyncIterable<ClaudeRawEvent> {
  return async function* (_request: ClaudeRunRequest): AsyncIterable<ClaudeRawEvent> {
    for (const event of events) {
      yield event;
    }
  };
}

function createNoopBootstrap(): ReturnType<ClaudeBootstrapper> {
  return {
    authMode: 'api_key',
    model: 'claude-3-7-sonnet-latest',
    apiKey: 'sk-claude',
    apiKeySource: 'CLAUDE_API_KEY',
  };
}

function createProvider(runner: (request: ClaudeRunRequest) => AsyncIterable<ClaudeRawEvent>): ClaudeProvider {
  return new ClaudeProvider(runner, () => createNoopBootstrap());
}

async function collectEvents(
  provider: ClaudeProvider,
  prompt = 'Implement the requested change.',
  options: ProviderRunOptions = defaultOptions,
): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];

  for await (const event of provider.run(prompt, options)) {
    events.push(event);
  }

  return events;
}

describe('claude provider', () => {
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
      provider: 'claude',
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

  it('bridges working directory and prompt options into the claude runner request', async () => {
    let capturedRequest: ClaudeRunRequest | undefined;
    const provider = createProvider(async function* (request: ClaudeRunRequest): AsyncIterable<ClaudeRawEvent> {
      capturedRequest = request;
      yield { type: 'result', content: 'ok' };
    });

    const options: ProviderRunOptions = {
      workingDirectory: '/work/alphred',
      systemPrompt: 'Be concise and deterministic.',
      context: ['issue=14', 'provider=claude'],
      timeout: 30_000,
    };

    const events = await collectEvents(provider, 'Implement adapter v1.', options);

    expect(events.map((event) => event.type)).toEqual(['system', 'result']);
    expect(capturedRequest).toBeDefined();
    expect(capturedRequest?.workingDirectory).toBe('/work/alphred');
    expect(capturedRequest?.systemPrompt).toBe('Be concise and deterministic.');
    expect(capturedRequest?.context).toEqual(['issue=14', 'provider=claude']);
    expect(capturedRequest?.timeout).toBe(30_000);
    expect(capturedRequest?.bridgedPrompt).toContain('System prompt:\nBe concise and deterministic.');
    expect(capturedRequest?.bridgedPrompt).toContain('Context:\n[1] issue=14\n[2] provider=claude');
    expect(capturedRequest?.bridgedPrompt).toContain('User prompt:\nImplement adapter v1.');
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
        code: 'CLAUDE_INVALID_OPTIONS',
      });
    }

    await expect(
      (async () => {
        for await (const event of provider.run('prompt', undefined as unknown as ProviderRunOptions)) {
          void event;
        }
      })(),
    ).rejects.toMatchObject({
      code: 'CLAUDE_INVALID_OPTIONS',
    });
  });

  it('throws a typed error when optional options are malformed', async () => {
    const provider = createProvider(createRunner([{ type: 'result', content: '' }]));
    const invalidOptionalOptions = [
      { workingDirectory: '/tmp/alphred-claude-test', context: 'invalid-context' },
      { workingDirectory: '/tmp/alphred-claude-test', context: null },
      { workingDirectory: '/tmp/alphred-claude-test', systemPrompt: 42 },
      { workingDirectory: '/tmp/alphred-claude-test', systemPrompt: { text: 'be concise' } },
      { workingDirectory: '/tmp/alphred-claude-test', timeout: 3_000_000_000 },
      { workingDirectory: '/tmp/alphred-claude-test', timeout: Number.MAX_SAFE_INTEGER },
    ];

    for (const options of invalidOptionalOptions) {
      await expect(collectEvents(provider, 'prompt', options as unknown as ProviderRunOptions)).rejects.toMatchObject({
        code: 'CLAUDE_INVALID_OPTIONS',
      });
    }
  });

  it('throws a typed error when claude emits unsupported event types', async () => {
    const provider = createProvider(createRunner([{ type: 'unsupported' }]));

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CLAUDE_INVALID_EVENT',
    });
  });

  it('throws a typed error when claude emits events after result', async () => {
    const provider = createProvider(
      createRunner([
        { type: 'result', content: 'done' },
        { type: 'usage', metadata: { tokens: 1 } },
      ]),
    );

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CLAUDE_INVALID_EVENT',
    });
  });

  it('throws a typed error when claude completes without a result event', async () => {
    const provider = createProvider(createRunner([{ type: 'assistant', content: 'partial output' }]));

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CLAUDE_MISSING_RESULT',
    });
  });

  it('wraps runner failures in the claude provider error path', async () => {
    const provider = createProvider(async function* (_request: ClaudeRunRequest): AsyncIterable<ClaudeRawEvent> {
      throw new Error('claude process crashed');
      yield { type: 'result', content: '' };
    });

    try {
      await collectEvents(provider);
      throw new Error('Expected provider run to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ClaudeProviderError);

      const typedError = error as ClaudeProviderError;
      expect(typedError.code).toBe('CLAUDE_INTERNAL_ERROR');
      expect(typedError.details).toMatchObject({
        classification: 'internal',
        retryable: false,
      });
      expect(typedError.cause).toBeInstanceOf(Error);
      expect((typedError.cause as Error).message).toBe('claude process crashed');
    }
  });

  it('fails fast with a typed auth error when bootstrap detects missing auth', async () => {
    const provider = new ClaudeProvider(
      createRunner([{ type: 'result', content: 'ok' }]),
      () => {
        throw new ClaudeBootstrapError(
          'CLAUDE_BOOTSTRAP_MISSING_AUTH',
          'Claude provider requires an API key via CLAUDE_API_KEY or ANTHROPIC_API_KEY.',
        );
      },
    );

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CLAUDE_AUTH_ERROR',
      details: {
        bootstrapCode: 'CLAUDE_BOOTSTRAP_MISSING_AUTH',
        classification: 'auth',
        retryable: false,
      },
      retryable: false,
    });
  });

  it('maps deterministic bootstrap config failures to non-retryable config errors', async () => {
    const provider = new ClaudeProvider(
      createRunner([{ type: 'result', content: 'ok' }]),
      () => {
        throw new ClaudeBootstrapError(
          'CLAUDE_BOOTSTRAP_INVALID_CONFIG',
          'Claude provider requires ANTHROPIC_BASE_URL to be a valid URL when set.',
          { envKey: 'ANTHROPIC_BASE_URL' },
        );
      },
    );

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CLAUDE_INVALID_CONFIG',
      details: {
        bootstrapCode: 'CLAUDE_BOOTSTRAP_INVALID_CONFIG',
        classification: 'config',
        retryable: false,
        envKey: 'ANTHROPIC_BASE_URL',
      },
    });
  });

  it('fails fast with deterministic internal errors for unknown bootstrap failures', async () => {
    const bootstrapFailure = new Error('socket timeout while probing runtime');
    const provider = new ClaudeProvider(
      createRunner([{ type: 'result', content: 'ok' }]),
      () => {
        throw bootstrapFailure;
      },
    );

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CLAUDE_INTERNAL_ERROR',
      message: 'Claude provider bootstrap failed with an unknown internal error.',
      retryable: false,
      details: {
        classification: 'internal',
        retryable: false,
      },
      cause: bootstrapFailure,
    });
  });
});
