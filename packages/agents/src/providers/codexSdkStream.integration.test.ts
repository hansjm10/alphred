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
  // Baseline fixture matrix for Codex SDK stream contracts used by this suite.
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
      metadata: {
        routingDecision: 'approved',
      },
    },
  ] as const,
  legacyRoutingDecisionKeyIgnored: [
    { type: 'thread.started', thread_id: 'thread-legacy-routing-key-1' },
    { type: 'turn.started' },
    {
      type: 'item.completed',
      item: {
        id: 'msg-1',
        type: 'agent_message',
        text: 'Completed using legacy routing key metadata.',
      },
    },
    {
      type: 'turn.completed',
      usage: {
        input_tokens: 12,
        cached_input_tokens: 0,
        output_tokens: 4,
      },
      metadata: {
        routing_decision: 'approved',
      },
    },
  ] as const,
  canonicalRoutingDecisionAcrossLocations: [
    { type: 'thread.started', thread_id: 'thread-routing-canonical-later-1' },
    { type: 'turn.started' },
    {
      type: 'item.completed',
      item: {
        id: 'msg-1',
        type: 'agent_message',
        text: 'Canonical routing metadata should win across locations.',
      },
    },
    {
      type: 'turn.completed',
      usage: {
        input_tokens: 16,
        cached_input_tokens: 0,
        output_tokens: 6,
      },
      routing_decision: 'approved',
      result_metadata: {
        routingDecision: 'changes_requested',
      },
    },
  ] as const,
  invalidCanonicalRoutingDecisionWithLegacyFallbackIgnored: [
    { type: 'thread.started', thread_id: 'thread-routing-legacy-ignored-1' },
    { type: 'turn.started' },
    {
      type: 'item.completed',
      item: {
        id: 'msg-1',
        type: 'agent_message',
        text: 'Legacy routing metadata should be ignored when canonical value is unsupported.',
      },
    },
    {
      type: 'turn.completed',
      usage: {
        input_tokens: 14,
        cached_input_tokens: 0,
        output_tokens: 5,
      },
      routingDecision: 'unknown_signal',
      resultMetadata: {
        routing_decision: 'blocked',
      },
    },
  ] as const,
  invalidRoutingDecision: [
    { type: 'thread.started', thread_id: 'thread-invalid-routing-1' },
    { type: 'turn.started' },
    {
      type: 'item.completed',
      item: {
        id: 'msg-1',
        type: 'agent_message',
        text: 'Completed with unsupported routing decision.',
      },
    },
    {
      type: 'turn.completed',
      usage: {
        input_tokens: 20,
        cached_input_tokens: 0,
        output_tokens: 8,
      },
      metadata: {
        routingDecision: 'unsupported_signal',
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
  failureInternal: [
    { type: 'thread.started', thread_id: 'thread-failure-internal-1' },
    {
      type: 'turn.failed',
      error: {
        message: 'Sample rate mismatch in audio parser',
      },
    },
  ] as const,
  failureMalformedError: [
    { type: 'thread.started', thread_id: 'thread-failure-malformed-1' },
    {
      type: 'turn.failed',
      error: {},
    },
  ] as const,
};

// Coverage boundary:
// - This file validates fixture-driven Codex SDK stream contracts.
// - codex.test.ts validates broader provider behavior and mixed event paths.
describe('codex provider sdk stream integration fixtures', () => {
  it('maps the success fixture into deterministic ordered provider events', async () => {
    const capture: CapturedSdkInvocation = {};
    const provider = createProviderForFixture(sdkStreamFixtures.success, capture);

    const events = await collectEvents(provider, 'Apply integration fixture tests.');

    expect(events.map((event) => event.type)).toEqual(['system', 'tool_use', 'tool_result', 'assistant', 'usage', 'result']);
    expect(events[1].content).toBe('pnpm test');
    expect(JSON.parse(events[2].content)).toMatchObject({
      command: 'pnpm test',
      output: 'all tests passed',
      exit_code: 0,
    });
    expect(events[3].content).toBe('All required changes are complete.');
    expect(events[5].content).toBe('All required changes are complete.');
    expect(events[5].metadata).toMatchObject({
      routingDecision: 'approved',
    });
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
    expect(capture.threadOptions).toEqual({
      model: 'gpt-5-codex',
      workingDirectory: '/tmp/alphred-codex-integration',
    });
    expect(capture.input).toBe('Apply integration fixture tests.');
    expect(capture.turnOptions).toBeUndefined();
  });

  it('drops unsupported routing decision metadata from terminal result events', async () => {
    const provider = createProviderForFixture(sdkStreamFixtures.invalidRoutingDecision);

    const events = await collectEvents(provider, 'Apply integration fixture tests.');

    expect(events.map((event) => event.type)).toEqual(['system', 'assistant', 'usage', 'result']);
    expect(events[3].content).toBe('Completed with unsupported routing decision.');
    expect(events[3].metadata).toBeUndefined();
  });

  it('ignores legacy routing_decision metadata on terminal result events', async () => {
    const provider = createProviderForFixture(sdkStreamFixtures.legacyRoutingDecisionKeyIgnored);

    const events = await collectEvents(provider, 'Apply integration fixture tests.');

    expect(events.map((event) => event.type)).toEqual(['system', 'assistant', 'usage', 'result']);
    expect(events[3].content).toBe('Completed using legacy routing key metadata.');
    expect(events[3].metadata).toBeUndefined();
  });

  it('prefers canonical routingDecision across metadata locations when multiple canonical values appear', async () => {
    const provider = createProviderForFixture(sdkStreamFixtures.canonicalRoutingDecisionAcrossLocations);

    const events = await collectEvents(provider, 'Apply integration fixture tests.');

    expect(events.map((event) => event.type)).toEqual(['system', 'assistant', 'usage', 'result']);
    expect(events[3].content).toBe('Canonical routing metadata should win across locations.');
    expect(events[3].metadata).toMatchObject({
      routingDecision: 'changes_requested',
    });
  });

  it('does not fall back to legacy routing_decision when canonical value is unsupported', async () => {
    const provider = createProviderForFixture(sdkStreamFixtures.invalidCanonicalRoutingDecisionWithLegacyFallbackIgnored);

    const events = await collectEvents(provider, 'Apply integration fixture tests.');

    expect(events.map((event) => event.type)).toEqual(['system', 'assistant', 'usage', 'result']);
    expect(events[3].content).toBe('Legacy routing metadata should be ignored when canonical value is unsupported.');
    expect(events[3].metadata).toBeUndefined();
  });

  it('passes an abort signal to sdk turn options when timeout is configured', async () => {
    const capture: CapturedSdkInvocation = {};
    const provider = createProviderForFixture(sdkStreamFixtures.success, capture);

    await collectEvents(provider, 'Apply integration fixture tests.', {
      ...defaultOptions,
      timeout: 25_000,
    });

    expect(capture.turnOptions).toMatchObject({
      signal: expect.any(AbortSignal),
    });
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

  it('classifies non-timeout failure fixtures into deterministic internal provider failures', async () => {
    const provider = createProviderForFixture(sdkStreamFixtures.failureInternal);

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CODEX_INTERNAL_ERROR',
      retryable: false,
      details: {
        classification: 'internal',
        retryable: false,
      },
    });
  });

  it('fails deterministically with typed invalid-event errors when turn.failed has malformed error payload', async () => {
    const provider = createProviderForFixture(sdkStreamFixtures.failureMalformedError);

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: 'CODEX_INVALID_EVENT',
      details: {
        fieldPath: 'event.error.message',
      },
    });
  });
});
