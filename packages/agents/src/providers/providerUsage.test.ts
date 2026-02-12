import type { ProviderEvent, ProviderRunOptions } from '@alphred/shared';
import type { Codex } from '@openai/codex-sdk';
import { describe, expect, it } from 'vitest';
import type { AgentProvider } from '../provider.js';
import { ClaudeProvider } from './claude.js';
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

const noopBootstrap: CodexBootstrapper = () => ({
  client: {
    startThread: () => ({
      runStreamed: async () => ({
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
      }),
    }),
  } as unknown as Codex,
  authMode: 'api_key',
  model: 'gpt-5-codex',
  apiKey: 'sk-test',
  codexHome: '/tmp/.codex',
  codexBinaryPath: '/tmp/codex',
});

describe('provider usage metadata contract', () => {
  const integrationCases: [string, AgentProvider][] = [
    ['claude', new ClaudeProvider()],
    ['codex', new CodexProvider(undefined, noopBootstrap)],
  ];

  it.each(integrationCases)('emits a consistent adapter event envelope for %s provider', async (name, provider) => {
    const events = await collectEvents(provider, {
      workingDirectory: process.cwd(),
      maxTokens: 64,
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

  it.each(integrationCases)('emits parseable usage metadata for %s provider', async (name, provider) => {
    const usageEvents = await collectUsageEvents(provider, {
      workingDirectory: process.cwd(),
      maxTokens: 64,
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
});
