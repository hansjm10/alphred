import type { ProviderEvent, ProviderRunOptions } from '@alphred/shared';
import { describe, expect, it } from 'vitest';
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
