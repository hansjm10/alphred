import type { ProviderEvent, ProviderRunOptions } from '@alphred/shared';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { ClaudeProvider, type ClaudeBootstrapper, type ClaudeSdkQuery } from './claude.js';

const shouldRunLiveSmoke =
  process.env.CLAUDE_LIVE_SMOKE === '1'
  && process.env.CI !== 'true'
  && process.env.GITHUB_ACTIONS !== 'true';

const describeLive = shouldRunLiveSmoke ? describe : describe.skip;
const preferredLiveModels = ['sonnet', 'default', 'haiku'] as const;

const defaultOptions: ProviderRunOptions = {
  workingDirectory: process.cwd(),
  timeout: 60_000,
};

function createCliSessionBootstrap(): ReturnType<ClaudeBootstrapper> {
  return {
    authMode: 'api_key',
    model: 'default',
    // Test-only placeholder; live query wrapper removes key env vars to use CLI session auth.
    apiKey: 'cli-session-auth',
    apiKeySource: 'CLAUDE_API_KEY',
  };
}

function createCliSessionQueryWrapper(): ClaudeSdkQuery {
  return ((params: Parameters<ClaudeSdkQuery>[0]) => {
    const originalOptions = (params.options ?? {}) as Record<string, unknown>;
    const originalEnv = originalOptions.env;
    const nextEnv =
      originalEnv && typeof originalEnv === 'object' && !Array.isArray(originalEnv)
        ? { ...(originalEnv as Record<string, string | undefined>) }
        : {};

    delete nextEnv.CLAUDE_API_KEY;
    delete nextEnv.ANTHROPIC_API_KEY;
    const nextOptions: Record<string, unknown> = {
      ...originalOptions,
      env: nextEnv,
    };

    return query({
      prompt: params.prompt,
      options: nextOptions,
    });
  }) as unknown as ClaudeSdkQuery;
}

function collectSupportedModelValues(models: unknown): string[] {
  if (!Array.isArray(models)) {
    return [];
  }

  return models
    .map((model): string | undefined => {
      if (!model || typeof model !== 'object' || Array.isArray(model)) {
        return undefined;
      }
      const value = (model as { value?: unknown }).value;
      return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
    })
    .filter((value): value is string => value !== undefined);
}

function parseLiveModelArg(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (typeof token !== 'string') {
      continue;
    }

    if (token.startsWith('--claude-live-model=')) {
      const value = token.slice('--claude-live-model='.length).trim();
      return value.length > 0 ? value : undefined;
    }

    if (token === '--claude-live-model') {
      const nextToken = argv[index + 1];
      if (typeof nextToken === 'string' && nextToken.trim().length > 0) {
        return nextToken.trim();
      }
    }
  }

  return undefined;
}

async function resolveLiveModel(sdkQuery: ClaudeSdkQuery): Promise<string> {
  const configuredLiveModel = parseLiveModelArg(process.argv);
  if (configuredLiveModel) {
    return configuredLiveModel;
  }

  const stream = sdkQuery({
    prompt: 'Return exactly OK.',
    options: {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CLAUDE_API_KEY: undefined,
        ANTHROPIC_API_KEY: undefined,
      },
    },
  }) as {
    supportedModels?: () => Promise<unknown>;
    close?: () => void;
  };

  try {
    const models = await stream.supportedModels?.();
    const values = collectSupportedModelValues(models);

    for (const preferredModel of preferredLiveModels) {
      if (values.includes(preferredModel)) {
        return preferredModel;
      }
    }

    return values[0] ?? 'default';
  } finally {
    stream.close?.();
  }
}

async function collectEvents(
  provider: ClaudeProvider,
  prompt: string,
  options: ProviderRunOptions = defaultOptions,
): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of provider.run(prompt, options)) {
    events.push(event);
  }
  return events;
}

describeLive('claude provider live smoke integration', () => {
  it(
    'runs against live Claude SDK credentials and returns a valid provider event stream',
    async () => {
      const sdkQuery = createCliSessionQueryWrapper();
      const liveModel = await resolveLiveModel(sdkQuery);
      const provider = new ClaudeProvider(
        undefined,
        () => ({
          ...createCliSessionBootstrap(),
          model: liveModel,
        }),
        sdkQuery,
      );
      const events = await collectEvents(
        provider,
        'Reply with exactly the word PONG. Do not add punctuation or explanation.',
      );

      expect(events.length).toBeGreaterThan(2);
      expect(events[0]?.type).toBe('system');
      expect(events.at(-1)?.type).toBe('result');
      expect(events.some((event) => event.type === 'usage')).toBe(true);
      expect(typeof events.at(-1)?.content).toBe('string');
      expect((events.at(-1)?.content ?? '').length).toBeGreaterThan(0);
      expect(typeof liveModel).toBe('string');
      expect(liveModel.length).toBeGreaterThan(0);
    },
    90_000,
  );
});
