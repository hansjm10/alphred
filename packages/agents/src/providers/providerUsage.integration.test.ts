import type { ProviderEvent, ProviderRunOptions } from '@alphred/shared';
import { describe, expect, it } from 'vitest';
import type { AgentProvider } from '../provider.js';
import { ClaudeProvider } from './claude.js';
import { CodexProvider } from './codex.js';

const runProviderIntegration = process.env.ALPHRED_RUN_PROVIDER_USAGE_INTEGRATION === '1';

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

async function collectUsageEvents(provider: AgentProvider, options: ProviderRunOptions): Promise<ProviderEvent[]> {
  const usageEvents: ProviderEvent[] = [];

  for await (const event of provider.run('Return a short test response.', options)) {
    if (event.type === 'usage') {
      usageEvents.push(event);
    }
  }

  return usageEvents;
}

describe.skipIf(!runProviderIntegration)('provider usage metadata integration (manual)', () => {
  const integrationCases: [string, AgentProvider][] = [
    ['claude', new ClaudeProvider()],
    ['codex', new CodexProvider()],
  ];

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
