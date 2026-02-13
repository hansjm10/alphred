import type { ProviderEvent, ProviderRunOptions } from '@alphred/shared';
import type { Codex } from '@openai/codex-sdk';
import { describe, expect, it } from 'vitest';
import type { AgentProvider } from '../provider.js';
import { ClaudeProvider, type ClaudeBootstrapper, type ClaudeSdkQuery } from './claude.js';
import { CodexProvider, type CodexBootstrapper } from './codex.js';

function hasTokenUsageShape(metadata: Record<string, unknown>): boolean {
  const directInputTokens = metadata.inputTokens;
  const directOutputTokens = metadata.outputTokens;
  if (typeof directInputTokens === 'number' && typeof directOutputTokens === 'number') {
    return true;
  }

  const snakeCaseInputTokens = metadata.input_tokens;
  const snakeCaseOutputTokens = metadata.output_tokens;
  if (typeof snakeCaseInputTokens === 'number' && typeof snakeCaseOutputTokens === 'number') {
    return true;
  }

  if (
    typeof metadata.tokens === 'number' ||
    typeof metadata.tokensUsed === 'number' ||
    typeof metadata.totalTokens === 'number' ||
    typeof metadata.total_tokens === 'number'
  ) {
    return true;
  }

  const nestedUsage = metadata.usage;
  if (!nestedUsage || typeof nestedUsage !== 'object') {
    return false;
  }

  return hasTokenUsageShape(nestedUsage as Record<string, unknown>);
}

async function collectEvents(provider: AgentProvider, options: ProviderRunOptions): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];

  for await (const event of provider.run('Return a short test response.', options)) {
    events.push(event);
  }

  return events;
}

async function collectUsageEvents(provider: AgentProvider, options: ProviderRunOptions): Promise<ProviderEvent[]> {
  const events = await collectEvents(provider, options);
  return events.filter((event) => event.type === 'usage');
}

type CapturedSdkInvocation = {
  threadOptions?: unknown;
  input?: unknown;
  turnOptions?: unknown;
};

function createNoopBootstrap(capture?: CapturedSdkInvocation): ReturnType<CodexBootstrapper> {
  return {
    client: {
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
                yield { type: 'thread.started', thread_id: 'thread-1' };
                yield {
                  type: 'item.completed',
                  item: {
                    id: 'message-1',
                    type: 'agent_message',
                    text: 'Done',
                  },
                };
                yield {
                  type: 'turn.completed',
                  usage: {
                    input_tokens: 10,
                    cached_input_tokens: 0,
                    output_tokens: 3,
                  },
                };
              })(),
            };
          },
        };
      },
    } as unknown as Codex,
    authMode: 'api_key',
    model: 'gpt-5-codex',
    apiKey: 'sk-test',
    codexHome: '/tmp/.codex',
    codexBinaryPath: '/tmp/codex',
  };
}

function createNoopClaudeBootstrap(): ReturnType<ClaudeBootstrapper> {
  return {
    authMode: 'api_key',
    model: 'claude-3-7-sonnet-latest',
    apiKey: 'sk-test',
    apiKeySource: 'CLAUDE_API_KEY',
  };
}

function createNoopClaudeQuery(): ClaudeSdkQuery {
  return ((params: { prompt: string | AsyncIterable<unknown> }) => {
    void params;
    return (async function* () {
      yield {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: 'Done',
            },
          ],
        },
      };
      yield {
        type: 'result',
        subtype: 'success',
        result: 'Done',
        usage: {
          input_tokens: 10,
          output_tokens: 3,
        },
      };
    })();
  }) as unknown as ClaudeSdkQuery;
}

describe('provider usage metadata contract', () => {
  const integrationCases: [string, () => AgentProvider][] = [
    ['claude', () => new ClaudeProvider(undefined, () => createNoopClaudeBootstrap(), createNoopClaudeQuery())],
    ['codex', () => new CodexProvider(undefined, () => createNoopBootstrap())],
  ];

  it.each(integrationCases)('emits a consistent adapter event envelope for %s provider', async (name, createProvider) => {
    const provider = createProvider();
    const events = await collectEvents(provider, {
      workingDirectory: process.cwd(),
    });

    expect(events.length, `${name} provider emitted no events.`).toBeGreaterThan(0);
    expect(events[0]?.type).toBe('system');
    expect(events[0]?.metadata).toMatchObject({
      provider: name,
    });

    const eventTypes = events.map((event) => event.type);
    expect(eventTypes).toEqual(['system', 'assistant', 'usage', 'result']);
    expect(events[eventTypes.length - 1]?.type).toBe('result');
  });

  it.each(integrationCases)('emits parseable usage metadata for %s provider', async (name, createProvider) => {
    const provider = createProvider();
    const usageEvents = await collectUsageEvents(provider, {
      workingDirectory: process.cwd(),
    });

    expect(
      usageEvents.length,
      `${name} provider emitted no usage events. The SDK adapter may not be wired yet.`,
    ).toBeGreaterThan(0);

    for (const event of usageEvents) {
      expect(event.metadata).toBeDefined();
      expect(
        hasTokenUsageShape(event.metadata as Record<string, unknown>),
        `${name} usage metadata is not in a recognized token format`,
      ).toBe(true);
    }
  });

  it.each(integrationCases)(
    'preserves run-shaping metadata for realistic options for %s provider',
    async (name, createProvider) => {
      const provider = createProvider();
      const events = await collectEvents(provider, {
        workingDirectory: process.cwd(),
        systemPrompt: 'Prefer deterministic and concise output.',
        context: ['repo=alphred', 'issue=27'],
        timeout: 30_000,
      });

      expect(events.map((event) => event.type)).toEqual(['system', 'assistant', 'usage', 'result']);
      expect(events[0]?.metadata).toMatchObject({
        provider: name,
        hasSystemPrompt: true,
        contextItemCount: 2,
        timeout: 30_000,
      });
    },
  );

  it('retains codex cached_input_tokens while exposing normalized usage totals', async () => {
    const capture: CapturedSdkInvocation = {};
    const provider = new CodexProvider(undefined, () => createNoopBootstrap(capture));
    const usageEvents = await collectUsageEvents(provider, {
      workingDirectory: process.cwd(),
      timeout: 15_000,
    });

    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]?.metadata).toMatchObject({
      input_tokens: 10,
      output_tokens: 3,
      total_tokens: 13,
      cached_input_tokens: 0,
      usage: {
        input_tokens: 10,
        output_tokens: 3,
        total_tokens: 13,
      },
    });
    expect(capture.threadOptions).toMatchObject({
      model: 'gpt-5-codex',
      workingDirectory: process.cwd(),
    });
    expect(capture.turnOptions).toMatchObject({
      signal: expect.any(AbortSignal),
    });
  });

  it('accepts Claude-style cumulative usage payload variants in the shared token contract', () => {
    const claudeUsagePayloads: Record<string, unknown>[] = [
      {
        input_tokens: 20,
        output_tokens: 8,
        total_tokens: 28,
        usage: {
          input_tokens: 20,
          output_tokens: 8,
          total_tokens: 28,
        },
      },
      {
        inputTokens: 20,
        outputTokens: 8,
      },
      {
        usage: {
          totalTokens: 28,
        },
      },
      {
        usage: {
          tokensUsed: 28,
        },
      },
      {
        tokens: 4,
        usage: {
          total_tokens: 28,
        },
      },
    ];

    for (const payload of claudeUsagePayloads) {
      expect(hasTokenUsageShape(payload)).toBe(true);
    }
  });

  it('accepts mixed incremental and nested cumulative usage payload shapes', () => {
    const mixedPayloads: Record<string, unknown>[] = [
      {
        tokens: 12,
      },
      {
        usage: {
          input_tokens: 9,
          output_tokens: 6,
        },
      },
      {
        tokens: 2,
        usage: {
          usage: {
            total_tokens: 15,
          },
        },
      },
    ];

    for (const payload of mixedPayloads) {
      expect(hasTokenUsageShape(payload)).toBe(true);
    }
  });

  it('handles nested usage token metadata seen in provider payloads', () => {
    expect(hasTokenUsageShape({ usage: { usage: { total_tokens: 21 } } })).toBe(true);
    expect(hasTokenUsageShape({ usage: { usage: { tokensUsed: 21 } } })).toBe(true);
  });

  it('rejects malformed usage metadata that only contains non-numeric token fields', () => {
    expect(hasTokenUsageShape({ input_tokens: '10', output_tokens: 3 } as unknown as Record<string, unknown>)).toBe(false);
    expect(hasTokenUsageShape({ usage: { total_tokens: '13' } } as unknown as Record<string, unknown>)).toBe(false);
  });
});
