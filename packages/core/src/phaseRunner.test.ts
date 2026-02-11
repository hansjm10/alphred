import type { PhaseDefinition } from '@alphred/shared';
import { describe, expect, it } from 'vitest';
import { runPhase } from './phaseRunner.js';

describe('runPhase', () => {
  it('returns the placeholder phase result contract', async () => {
    const phase: PhaseDefinition = {
      name: 'draft',
      type: 'agent',
      prompt: 'Draft a response',
      transitions: [],
    };

    await expect(runPhase(phase, { runId: 1 })).resolves.toEqual({
      success: true,
      report: '',
      events: [],
      tokensUsed: 0,
    });
  });
});
