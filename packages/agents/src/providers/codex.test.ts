import type { ProviderEvent, ProviderRunOptions } from '@alphred/shared';
import { describe, expect, it } from 'vitest';
import {
  CodexProvider,
  CodexProviderError,
  type CodexRawEvent,
  type CodexRunRequest,
} from './codex.js';

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
    const provider = new CodexProvider(
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

  it('bridges working directory and prompt options into the codex runner request', async () => {
    let capturedRequest: CodexRunRequest | undefined;
    const provider = new CodexProvider(async function* (request: CodexRunRequest): AsyncIterable<CodexRawEvent> {
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

  it('throws a typed error when required options are invalid', async () => {
    const provider = new CodexProvider(createRunner([{ type: 'result', content: '' }]));

    await expect(
      collectEvents(provider, 'prompt', {
        workingDirectory: '   ',
      }),
    ).rejects.toMatchObject({
      code: 'CODEX_INVALID_OPTIONS',
    });
  });

  it('throws a typed error when codex emits unsupported event types', async () => {
    const provider = new CodexProvider(createRunner([{ type: 'unsupported' }]));

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CODEX_INVALID_EVENT',
    });
  });

  it('throws a typed error when codex emits events after result', async () => {
    const provider = new CodexProvider(
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
    const provider = new CodexProvider(createRunner([{ type: 'assistant', content: 'partial output' }]));

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CODEX_MISSING_RESULT',
    });
  });

  it('wraps runner failures in the codex provider error path', async () => {
    const provider = new CodexProvider(async function* (_request: CodexRunRequest): AsyncIterable<CodexRawEvent> {
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
});
