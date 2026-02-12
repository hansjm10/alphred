import type { ProviderEvent, ProviderRunOptions } from '@alphred/shared';
import { describe, expect, it } from 'vitest';
import {
  ClaudeProvider,
  ClaudeProviderError,
  type ClaudeRawEvent,
  type ClaudeRunRequest,
} from './claude.js';

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
    const provider = new ClaudeProvider(
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
    const provider = new ClaudeProvider(
      createRunner([
        { type: 'usage', metadata: { tokens: 30 } },
        { type: 'result', content: 'done' },
      ]),
    );

    const events = await collectEvents(provider);

    expect(events.map((event) => event.type)).toEqual(['system', 'usage', 'result']);
    expect(events[1].metadata).toEqual({ tokens: 30 });
  });

  it('bridges working directory and prompt options into the claude runner request', async () => {
    let capturedRequest: ClaudeRunRequest | undefined;
    const provider = new ClaudeProvider(async function* (request: ClaudeRunRequest): AsyncIterable<ClaudeRawEvent> {
      capturedRequest = request;
      yield { type: 'result', content: 'ok' };
    });

    const options: ProviderRunOptions = {
      workingDirectory: '/work/alphred',
      systemPrompt: 'Be concise and deterministic.',
      context: ['issue=14', 'provider=claude'],
      maxTokens: 512,
      timeout: 30_000,
    };

    const events = await collectEvents(provider, 'Implement adapter v1.', options);

    expect(events.map((event) => event.type)).toEqual(['system', 'result']);
    expect(capturedRequest).toBeDefined();
    expect(capturedRequest?.workingDirectory).toBe('/work/alphred');
    expect(capturedRequest?.systemPrompt).toBe('Be concise and deterministic.');
    expect(capturedRequest?.context).toEqual(['issue=14', 'provider=claude']);
    expect(capturedRequest?.maxTokens).toBe(512);
    expect(capturedRequest?.timeout).toBe(30_000);
    expect(capturedRequest?.bridgedPrompt).toContain('System prompt:\nBe concise and deterministic.');
    expect(capturedRequest?.bridgedPrompt).toContain('Context:\n[1] issue=14\n[2] provider=claude');
    expect(capturedRequest?.bridgedPrompt).toContain('User prompt:\nImplement adapter v1.');
  });

  it('normalizes circular event content without default object stringification', async () => {
    const circularContent: Record<string, unknown> = { step: 'drafting' };
    circularContent.self = circularContent;
    const provider = new ClaudeProvider(
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
    const provider = new ClaudeProvider(createRunner([{ type: 'result', content: '' }]));
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
    const provider = new ClaudeProvider(createRunner([{ type: 'result', content: '' }]));
    const invalidOptionalOptions = [
      { workingDirectory: '/tmp/alphred-claude-test', context: 'invalid-context' },
      { workingDirectory: '/tmp/alphred-claude-test', context: null },
      { workingDirectory: '/tmp/alphred-claude-test', systemPrompt: 42 },
      { workingDirectory: '/tmp/alphred-claude-test', systemPrompt: { text: 'be concise' } },
    ];

    for (const options of invalidOptionalOptions) {
      await expect(collectEvents(provider, 'prompt', options as unknown as ProviderRunOptions)).rejects.toMatchObject({
        code: 'CLAUDE_INVALID_OPTIONS',
      });
    }
  });

  it('throws a typed error when claude emits unsupported event types', async () => {
    const provider = new ClaudeProvider(createRunner([{ type: 'unsupported' }]));

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CLAUDE_INVALID_EVENT',
    });
  });

  it('throws a typed error when claude emits events after result', async () => {
    const provider = new ClaudeProvider(
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
    const provider = new ClaudeProvider(createRunner([{ type: 'assistant', content: 'partial output' }]));

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CLAUDE_MISSING_RESULT',
    });
  });

  it('wraps runner failures in the claude provider error path', async () => {
    const provider = new ClaudeProvider(async function* (_request: ClaudeRunRequest): AsyncIterable<ClaudeRawEvent> {
      throw new Error('claude process crashed');
      yield { type: 'result', content: '' };
    });

    try {
      await collectEvents(provider);
      throw new Error('Expected provider run to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ClaudeProviderError);

      const typedError = error as ClaudeProviderError;
      expect(typedError.code).toBe('CLAUDE_RUN_FAILED');
      expect(typedError.cause).toBeInstanceOf(Error);
      expect((typedError.cause as Error).message).toBe('claude process crashed');
    }
  });
});
