import type { PhaseDefinition, ProviderEvent, ProviderRunOptions } from '@alphred/shared';
import { describe, expect, it, vi } from 'vitest';
import type { PhaseProvider } from './phaseRunner.js';
import { runPhase } from './phaseRunner.js';

const defaultOptions: ProviderRunOptions = {
  workingDirectory: '/tmp/alphred-worktree',
};

function createAgentPhase(): PhaseDefinition {
  return {
    name: 'draft',
    type: 'agent',
    provider: 'codex',
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
      events: emittedEvents,
      tokensUsed: 13,
    });
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
      events: [],
      tokensUsed: 0,
    });
  });
});
