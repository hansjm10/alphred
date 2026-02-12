import type { ProviderEvent, ProviderRunOptions } from '@alphred/shared';
import type { Codex } from '@openai/codex-sdk';
import { describe, expect, it } from 'vitest';
import { CodexProvider } from './codex.js';

const defaultOptions: ProviderRunOptions = {
  workingDirectory: '/tmp/alphred-codex-integration',
};

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

function createProviderForFixture(events: readonly unknown[], capture?: CapturedSdkInvocation): CodexProvider {
  return new CodexProvider(undefined, () => ({
    client: createMockSdkClient(events, capture),
    authMode: 'api_key',
    model: 'gpt-5-codex',
    apiKey: 'sk-test',
    codexHome: '/tmp/.codex',
    codexBinaryPath: '/tmp/codex',
  }));
}

async function collectEvents(
  provider: CodexProvider,
  prompt = 'Implement issue #30 tests.',
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
    { type: 'thread.started', thread_id: 'thread-success-1' },
    { type: 'turn.started' },
    {
      type: 'item.started',
      item: {
        id: 'cmd-1',
        type: 'command_execution',
        command: 'pnpm test',
      },
    },
    {
      type: 'item.completed',
      item: {
        id: 'cmd-1',
        type: 'command_execution',
        command: 'pnpm test',
        aggregated_output: 'all tests passed',
        exit_code: 0,
      },
    },
    {
      type: 'item.completed',
      item: {
        id: 'msg-1',
        type: 'agent_message',
        text: 'All required changes are complete.',
      },
    },
    {
      type: 'turn.completed',
      usage: {
        input_tokens: 20,
        cached_input_tokens: 0,
        output_tokens: 8,
      },
    },
  ] as const,
  partial: [
    { type: 'thread.started', thread_id: 'thread-partial-1' },
    { type: 'turn.started' },
    {
      type: 'item.completed',
      item: {
        id: 'msg-1',
        type: 'agent_message',
        text: 'Partial answer before stream ended unexpectedly.',
      },
    },
  ] as const,
  malformed: [
    { type: 'thread.started', thread_id: 'thread-malformed-1' },
    {
      type: 'item.completed',
      item: {
        id: 'msg-1',
        type: 'agent_message',
        text: 42,
      },
    },
  ] as const,
  failure: [
    { type: 'thread.started', thread_id: 'thread-failure-1' },
    {
      type: 'turn.failed',
      error: {
        message: 'transport timeout',
      },
    },
  ] as const,
};

describe('codex provider sdk stream integration fixtures', () => {
  it('maps the success fixture into deterministic ordered provider events', async () => {
    const capture: CapturedSdkInvocation = {};
    const provider = createProviderForFixture(sdkStreamFixtures.success, capture);

    const events = await collectEvents(provider, 'Apply integration fixture tests.');

    expect(events.map((event) => event.type)).toEqual(['system', 'tool_use', 'tool_result', 'assistant', 'usage', 'result']);
    expect(events[1].content).toBe('pnpm test');
    expect(events[3].content).toBe('All required changes are complete.');
    expect(events[5].content).toBe('All required changes are complete.');
    expect(events[4].metadata).toMatchObject({
      input_tokens: 20,
      output_tokens: 8,
      total_tokens: 28,
      usage: {
        input_tokens: 20,
        output_tokens: 8,
        total_tokens: 28,
      },
    });
    expect(capture.input).toBe('Apply integration fixture tests.');
  });

  it('fails deterministically when a partial fixture ends without a terminal result event', async () => {
    const provider = createProviderForFixture(sdkStreamFixtures.partial);

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CODEX_MISSING_RESULT',
    });
  });

  it('fails deterministically with typed invalid-event errors for malformed fixtures', async () => {
    const provider = createProviderForFixture(sdkStreamFixtures.malformed);

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CODEX_INVALID_EVENT',
      details: {
        fieldPath: 'item.text',
      },
    });
  });

  it('classifies failure fixtures into deterministic typed provider failures', async () => {
    const provider = createProviderForFixture(sdkStreamFixtures.failure);

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CODEX_TIMEOUT',
      retryable: true,
      details: {
        classification: 'timeout',
        retryable: true,
      },
    });
  });
});
