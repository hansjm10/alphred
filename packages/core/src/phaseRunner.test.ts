import type { PhaseDefinition, ProviderEvent, ProviderRunOptions } from '@alphred/shared';
import { describe, expect, it, vi } from 'vitest';
import type { PhaseProvider } from './phaseRunner.js';
import { runPhase } from './phaseRunner.js';

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
    const phase: PhaseDefinition = {
      name: 'draft',
      type: 'agent',
      provider: 'codex',
      prompt: 'Draft a response',
      transitions: [],
    };
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

  it('throws when an agent phase is missing provider configuration', async () => {
    const phase: PhaseDefinition = {
      name: 'draft',
      type: 'agent',
      prompt: 'Draft a response',
      transitions: [],
    };
    const options: ProviderRunOptions = {
      workingDirectory: '/tmp/alphred-worktree',
    };

    await expect(
      runPhase(phase, options, {
        resolveProvider: () => createProvider([]),
      }),
    ).rejects.toThrow('Agent phase "draft" is missing a provider.');
  });

  it('propagates resolver failures', async () => {
    const phase: PhaseDefinition = {
      name: 'draft',
      type: 'agent',
      provider: 'codex',
      prompt: 'Draft a response',
      transitions: [],
    };
    const options: ProviderRunOptions = {
      workingDirectory: '/tmp/alphred-worktree',
    };
    const resolverError = new Error('Unknown provider "codex".');

    await expect(
      runPhase(phase, options, {
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
    const options: ProviderRunOptions = {
      workingDirectory: '/tmp/alphred-worktree',
    };
    const resolverSpy = vi.fn(() => createProvider([]));

    const result = await runPhase(phase, options, { resolveProvider: resolverSpy });

    expect(resolverSpy).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: true,
      report: '',
      events: [],
      tokensUsed: 0,
    });
  });
});
