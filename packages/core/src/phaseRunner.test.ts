import type { AgentProviderName, PhaseDefinition, ProviderEvent, ProviderRunOptions } from '@alphred/shared';
import { describe, expect, it, vi } from 'vitest';
import type { PhaseProvider } from './phaseRunner.js';
import { PhaseRunError, runPhase } from './phaseRunner.js';

const defaultOptions: ProviderRunOptions = {
  workingDirectory: '/tmp/alphred-worktree',
};

function createAgentPhase(provider: AgentProviderName = 'codex'): PhaseDefinition {
  return {
    name: 'draft',
    type: 'agent',
    provider,
    prompt: 'Draft a response',
    transitions: [],
  };
}

function createProvider(events: ProviderEvent[]): PhaseProvider {
  return {
    async *run(_prompt: string, _options: ProviderRunOptions): AsyncIterable<ProviderEvent> {
      for (const event of events) {
        yield event;
      }
    },
  };
}

describe('runPhase', () => {
  it('resolves provider from phase config and collects stream events', async () => {
    const phase = createAgentPhase();
    const options: ProviderRunOptions = {
      workingDirectory: '/tmp/alphred-worktree',
      context: ['prior output'],
    };
    const emittedEvents: ProviderEvent[] = [
      { type: 'system', content: 'provider started', timestamp: 100 },
      { type: 'usage', content: '', timestamp: 101, metadata: { tokens: 13 } },
      { type: 'assistant', content: 'intermediate text', timestamp: 102 },
      { type: 'result', content: 'final report', timestamp: 103 },
    ];
    const runSpy = vi.fn(async function *run(
      prompt: string,
      runOptions: ProviderRunOptions,
    ): AsyncIterable<ProviderEvent> {
      expect(prompt).toBe('Draft a response');
      expect(runOptions).toEqual(options);
      yield * emittedEvents;
    });
    const resolverSpy = vi.fn(() => ({ run: runSpy }));

    const result = await runPhase(phase, options, { resolveProvider: resolverSpy });

    expect(resolverSpy).toHaveBeenCalledWith('codex');
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      success: true,
      report: 'final report',
      routingDecision: null,
      events: emittedEvents,
      tokensUsed: 13,
    });
  });

  it('forwards streamed events to the optional onEvent callback in emission order', async () => {
    const phase = createAgentPhase();
    const emittedEvents: ProviderEvent[] = [
      { type: 'system', content: 'provider started', timestamp: 100 },
      { type: 'assistant', content: 'intermediate text', timestamp: 101 },
      { type: 'result', content: 'final report', timestamp: 102 },
    ];
    const onEvent = vi.fn();

    await runPhase(phase, defaultOptions, {
      resolveProvider: () => createProvider(emittedEvents),
      onEvent,
    });

    expect(onEvent).toHaveBeenCalledTimes(3);
    expect(onEvent.mock.calls.map(call => call[0])).toEqual(emittedEvents);
  });

  it('resolves the configured claude provider and preserves emitted events', async () => {
    const phase = createAgentPhase('claude');
    const emittedEvents: ProviderEvent[] = [
      { type: 'system', content: 'provider started', timestamp: 100 },
      { type: 'assistant', content: 'intermediate text', timestamp: 101 },
      { type: 'result', content: 'final report', timestamp: 102 },
    ];
    const runSpy = vi.fn(async function *run(): AsyncIterable<ProviderEvent> {
      yield* emittedEvents;
    });
    const resolverSpy = vi.fn(() => ({ run: runSpy }));

    const result = await runPhase(phase, defaultOptions, { resolveProvider: resolverSpy });

    expect(resolverSpy).toHaveBeenCalledWith('claude');
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(result.report).toBe('final report');
    expect(result.events).toEqual(emittedEvents);
  });

  it('uses the latest cumulative tokensUsed metadata without summing repeated usage events', async () => {
    const phase = createAgentPhase();
    const emittedEvents: ProviderEvent[] = [
      { type: 'usage', content: '', timestamp: 100, metadata: { tokensUsed: 120 } },
      { type: 'usage', content: '', timestamp: 101, metadata: { tokensUsed: 160 } },
      { type: 'result', content: 'done', timestamp: 102 },
    ];

    const result = await runPhase(phase, defaultOptions, {
      resolveProvider: () => createProvider(emittedEvents),
    });

    expect(result.tokensUsed).toBe(160);
  });

  it.each([
    ['tokensUsed', { tokensUsed: 24 }, 24],
    ['totalTokens', { totalTokens: 25 }, 25],
    ['total_tokens', { total_tokens: 26 }, 26],
    ['inputTokens+outputTokens', { inputTokens: 14, outputTokens: 13 }, 27],
    ['input_tokens+output_tokens', { input_tokens: 14, output_tokens: 14 }, 28],
    ['nested usage.totalTokens', { usage: { totalTokens: 29 } }, 29],
    ['nested usage.tokensUsed', { usage: { tokensUsed: 30 } }, 30],
    ['nested usage.inputTokens+outputTokens', { usage: { inputTokens: 20, outputTokens: 11 } }, 31],
    ['nested usage.input_tokens+output_tokens', { usage: { input_tokens: 20, output_tokens: 12 } }, 32],
  ])('supports cumulative usage metadata variant: %s', async (_name, metadata, expectedTokens) => {
    const phase = createAgentPhase('claude');
    const emittedEvents: ProviderEvent[] = [
      { type: 'usage', content: '', timestamp: 100, metadata },
      { type: 'result', content: 'done', timestamp: 101 },
    ];

    const result = await runPhase(phase, defaultOptions, {
      resolveProvider: () => createProvider(emittedEvents),
    });

    expect(result.tokensUsed).toBe(expectedTokens);
  });

  it('sums incremental usage metadata when tokens are emitted as deltas', async () => {
    const phase = createAgentPhase();
    const emittedEvents: ProviderEvent[] = [
      { type: 'usage', content: '', timestamp: 100, metadata: { tokens: 30 } },
      { type: 'usage', content: '', timestamp: 101, metadata: { tokens: 20 } },
      { type: 'result', content: 'done', timestamp: 102 },
    ];

    const result = await runPhase(phase, defaultOptions, {
      resolveProvider: () => createProvider(emittedEvents),
    });

    expect(result.tokensUsed).toBe(50);
  });

  it('reads cumulative token counts from nested usage metadata', async () => {
    const phase = createAgentPhase();
    const emittedEvents: ProviderEvent[] = [
      {
        type: 'usage',
        content: '',
        timestamp: 100,
        metadata: { usage: { input_tokens: 40, output_tokens: 15 } },
      },
      {
        type: 'usage',
        content: '',
        timestamp: 101,
        metadata: { usage: { total_tokens: 72 } },
      },
      { type: 'result', content: 'done', timestamp: 102 },
    ];

    const result = await runPhase(phase, defaultOptions, {
      resolveProvider: () => createProvider(emittedEvents),
    });

    expect(result.tokensUsed).toBe(72);
  });

  it('keeps the higher value when both incremental and cumulative usage metadata are present', async () => {
    const phase = createAgentPhase();
    const emittedEvents: ProviderEvent[] = [
      { type: 'usage', content: '', timestamp: 100, metadata: { tokens: 20 } },
      { type: 'usage', content: '', timestamp: 101, metadata: { totalTokens: 35 } },
      { type: 'usage', content: '', timestamp: 102, metadata: { tokens: 10 } },
      { type: 'result', content: 'done', timestamp: 103 },
    ];

    const result = await runPhase(phase, defaultOptions, {
      resolveProvider: () => createProvider(emittedEvents),
    });

    expect(result.tokensUsed).toBe(35);
  });

  it('keeps the higher incremental total when cumulative snapshots lag behind', async () => {
    const phase = createAgentPhase();
    const emittedEvents: ProviderEvent[] = [
      { type: 'usage', content: '', timestamp: 100, metadata: { tokens: 20 } },
      { type: 'usage', content: '', timestamp: 101, metadata: { usage: { tokensUsed: 30 } } },
      { type: 'usage', content: '', timestamp: 102, metadata: { tokens: 20 } },
      { type: 'result', content: 'done', timestamp: 103 },
    ];

    const result = await runPhase(phase, defaultOptions, {
      resolveProvider: () => createProvider(emittedEvents),
    });

    expect(result.tokensUsed).toBe(40);
  });

  it('keeps the higher incremental total when nested input/output snapshots lag behind', async () => {
    const phase = createAgentPhase('claude');
    const emittedEvents: ProviderEvent[] = [
      { type: 'usage', content: '', timestamp: 100, metadata: { tokens: 20 } },
      { type: 'usage', content: '', timestamp: 101, metadata: { usage: { input_tokens: 8, output_tokens: 7 } } },
      { type: 'usage', content: '', timestamp: 102, metadata: { tokens: 20 } },
      { type: 'result', content: 'done', timestamp: 103 },
    ];

    const result = await runPhase(phase, defaultOptions, {
      resolveProvider: () => createProvider(emittedEvents),
    });

    expect(result.tokensUsed).toBe(40);
  });

  it('prefers cumulative usage fields when both incremental and cumulative metadata exist on one event', async () => {
    const phase = createAgentPhase();
    const emittedEvents: ProviderEvent[] = [
      {
        type: 'usage',
        content: '',
        timestamp: 100,
        metadata: { tokens: 5, totalTokens: 40 },
      },
      { type: 'result', content: 'done', timestamp: 101 },
    ];

    const result = await runPhase(phase, defaultOptions, {
      resolveProvider: () => createProvider(emittedEvents),
    });

    expect(result.tokensUsed).toBe(40);
  });

  it('prefers nested cumulative usage over top-level incremental metadata on one event', async () => {
    const phase = createAgentPhase();
    const emittedEvents: ProviderEvent[] = [
      {
        type: 'usage',
        content: '',
        timestamp: 100,
        metadata: { tokens: 5, usage: { total_tokens: 40 } },
      },
      { type: 'result', content: 'done', timestamp: 101 },
    ];

    const result = await runPhase(phase, defaultOptions, {
      resolveProvider: () => createProvider(emittedEvents),
    });

    expect(result.tokensUsed).toBe(40);
  });

  it('extracts a structured routing decision from result metadata', async () => {
    const phase = createAgentPhase();
    const emittedEvents: ProviderEvent[] = [
      {
        type: 'result',
        content: 'final report',
        timestamp: 100,
        metadata: { routingDecision: 'approved' },
      },
    ];

    const result = await runPhase(phase, defaultOptions, {
      resolveProvider: () => createProvider(emittedEvents),
    });

    expect(result.routingDecision).toBe('approved');
  });

  it('treats unknown routing decision metadata as missing', async () => {
    const phase = createAgentPhase();
    const emittedEvents: ProviderEvent[] = [
      {
        type: 'result',
        content: 'final report',
        timestamp: 100,
        metadata: { routingDecision: 'unknown_signal' } as unknown as ProviderEvent['metadata'],
      },
    ];

    const result = await runPhase(phase, defaultOptions, {
      resolveProvider: () => createProvider(emittedEvents),
    });

    expect(result.routingDecision).toBeNull();
  });

  it('ignores legacy routing_decision metadata when canonical metadata is missing', async () => {
    const phase = createAgentPhase();
    const emittedEvents: ProviderEvent[] = [
      {
        type: 'result',
        content: 'final report',
        timestamp: 100,
        metadata: { routing_decision: 'approved' } as unknown as ProviderEvent['metadata'],
      },
    ];

    const result = await runPhase(phase, defaultOptions, {
      resolveProvider: () => createProvider(emittedEvents),
    });

    expect(result.routingDecision).toBeNull();
  });

  it('uses canonical routingDecision when both canonical and legacy routing metadata keys are present', async () => {
    const phase = createAgentPhase();
    const emittedEvents: ProviderEvent[] = [
      {
        type: 'result',
        content: 'final report',
        timestamp: 100,
        metadata: {
          routingDecision: 'changes_requested',
          routing_decision: 'approved',
        } as unknown as ProviderEvent['metadata'],
      },
    ];

    const result = await runPhase(phase, defaultOptions, {
      resolveProvider: () => createProvider(emittedEvents),
    });

    expect(result.routingDecision).toBe('changes_requested');
  });

  it('throws when an agent phase is missing provider configuration', async () => {
    const phase: PhaseDefinition = {
      name: 'draft',
      type: 'agent',
      prompt: 'Draft a response',
      transitions: [],
    };

    await expect(
      runPhase(phase, defaultOptions, {
        resolveProvider: () => createProvider([]),
      }),
    ).rejects.toThrow('Agent phase "draft" is missing a provider.');
  });

  it('propagates resolver failures', async () => {
    const phase = createAgentPhase();
    const resolverError = new Error('Unknown provider "codex".');

    await expect(
      runPhase(phase, defaultOptions, {
        resolveProvider: () => {
          throw resolverError;
        },
      }),
    ).rejects.toBe(resolverError);
  });

  it('throws when an agent provider stream completes without a result event', async () => {
    const phase = createAgentPhase();
    const emittedEvents: ProviderEvent[] = [
      { type: 'system', content: 'started', timestamp: 100 },
      { type: 'usage', content: '', timestamp: 101, metadata: { tokens: 8 } },
      { type: 'assistant', content: 'partial response', timestamp: 102 },
    ];

    await expect(
      runPhase(phase, defaultOptions, {
        resolveProvider: () => createProvider(emittedEvents),
      }),
    ).rejects.toThrow('Agent phase "draft" completed without a result event.');

    await expect(
      runPhase(phase, defaultOptions, {
        resolveProvider: () => createProvider(emittedEvents),
      }),
    ).rejects.toMatchObject({
      name: 'PhaseRunError',
      events: emittedEvents,
      tokensUsed: 8,
    } satisfies Partial<PhaseRunError>);
  });

  it('wraps provider runtime failures in PhaseRunError and preserves partial event history', async () => {
    const phase = createAgentPhase();
    const providerError = new Error('transport disconnected');
    const emittedBeforeFailure: ProviderEvent[] = [
      { type: 'system', content: 'started', timestamp: 100 },
      { type: 'usage', content: '', timestamp: 101, metadata: { tokens: 11 } },
    ];

    await expect(
      runPhase(phase, defaultOptions, {
        resolveProvider: () => ({
          async *run(): AsyncIterable<ProviderEvent> {
            yield emittedBeforeFailure[0];
            yield emittedBeforeFailure[1];
            throw providerError;
          },
        }),
      }),
    ).rejects.toMatchObject({
      name: 'PhaseRunError',
      message: 'Agent phase "draft" execution failed.',
      events: emittedBeforeFailure,
      tokensUsed: 11,
      cause: providerError,
    } satisfies Partial<PhaseRunError>);
  });

  it('skips provider resolution for non-agent phases', async () => {
    const phase: PhaseDefinition = {
      name: 'approval',
      type: 'human',
      prompt: 'Approve release',
      transitions: [],
    };
    const resolverSpy = vi.fn(() => createProvider([]));

    const result = await runPhase(phase, defaultOptions, { resolveProvider: resolverSpy });

    expect(resolverSpy).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: true,
      report: '',
      routingDecision: null,
      events: [],
      tokensUsed: 0,
    });
  });
});
