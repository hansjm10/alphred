import type { PhaseDefinition, WorkflowDefinition } from '@alphred/shared';
import { describe, expect, it } from 'vitest';
import { getFirstPhase, getPhaseByName, getPhaseTransitions } from './workflow.js';

function buildPhase(name: string, priority = 1): PhaseDefinition {
  return {
    name,
    type: 'agent',
    prompt: `${name} prompt`,
    transitions: [{ target: `${name}-next`, priority }],
  };
}

describe('workflow', () => {
  it('returns a phase by name when it exists', () => {
    const workflow: WorkflowDefinition = {
      name: 'demo',
      version: 1,
      phases: [buildPhase('plan'), buildPhase('execute')],
    };

    expect(getPhaseByName(workflow, 'execute')?.name).toBe('execute');
    expect(getPhaseByName(workflow, 'missing')).toBeUndefined();
  });

  it('returns transitions sorted by ascending priority without mutating input', () => {
    const phase: PhaseDefinition = {
      name: 'plan',
      type: 'agent',
      prompt: 'plan prompt',
      transitions: [
        { target: 'third', priority: 3 },
        { target: 'first', priority: 1 },
        { target: 'second', priority: 2 },
      ],
    };

    const sorted = getPhaseTransitions(phase);

    expect(sorted.map((transition) => transition.target)).toEqual(['first', 'second', 'third']);
    expect(phase.transitions.map((transition) => transition.target)).toEqual(['third', 'first', 'second']);
  });

  it('returns the first phase when available', () => {
    const workflow: WorkflowDefinition = {
      name: 'demo',
      version: 1,
      phases: [buildPhase('first'), buildPhase('second')],
    };

    expect(getFirstPhase(workflow)?.name).toBe('first');
    expect(getFirstPhase({ ...workflow, phases: [] })).toBeUndefined();
  });
});
