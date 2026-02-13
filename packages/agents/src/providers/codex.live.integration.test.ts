import type { ProviderEvent, ProviderRunOptions } from '@alphred/shared';
import { describe, expect, it } from 'vitest';
import { CodexProvider, CodexProviderError } from './codex.js';

const shouldRunLiveSmoke = process.env.CODEX_LIVE_SMOKE === '1';
const describeLive = shouldRunLiveSmoke ? describe : describe.skip;

const defaultOptions: ProviderRunOptions = {
  workingDirectory: process.cwd(),
  timeout: 90_000,
};

function formatDetail(details: Record<string, unknown> | undefined, key: string): string {
  const value = details?.[key];
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return 'n/a';
}

function formatCodexFailure(error: CodexProviderError): string {
  return [
    'Codex live smoke failed.',
    `code=${error.code}`,
    `classification=${formatDetail(error.details, 'classification')}`,
    `retryable=${String(error.retryable)}`,
    `statusCode=${formatDetail(error.details, 'statusCode')}`,
    `failureCode=${formatDetail(error.details, 'failureCode')}`,
    `message=${error.message}`,
  ].join(' ');
}

async function collectEvents(
  provider: CodexProvider,
  prompt: string,
  options: ProviderRunOptions = defaultOptions,
): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of provider.run(prompt, options)) {
    events.push(event);
  }

  return events;
}

describeLive('codex provider live smoke integration', () => {
  it(
    'runs against live Codex credentials and returns a valid provider event stream',
    async () => {
      const provider = new CodexProvider();
      let events: ProviderEvent[];

      try {
        events = await collectEvents(
          provider,
          'Reply with exactly the word PONG. Do not add punctuation or explanation.',
        );
      } catch (error) {
        if (error instanceof CodexProviderError) {
          throw new Error(formatCodexFailure(error));
        }

        throw error;
      }

      const terminalContent = events.at(-1)?.content;

      expect(events.length).toBeGreaterThan(1);
      expect(events.at(-1)?.type).toBe('result');
      expect(events.some((event) => event.type === 'usage')).toBe(true);
      expect(typeof terminalContent).toBe('string');
      expect(typeof terminalContent === 'string' ? terminalContent.trim().length : 0).toBeGreaterThan(0);
    },
    120_000,
  );
});
