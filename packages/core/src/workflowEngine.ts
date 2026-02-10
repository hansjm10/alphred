import type { WorkflowDefinition, Transition } from '@alphred/shared';
import { getPhaseByName, getPhaseTransitions } from './workflow.js';
import { evaluateGuard } from './guards.js';

export type TransitionResult = {
  transition: Transition;
  targetPhase: string;
} | null;

export function evaluateTransitions(
  workflow: WorkflowDefinition,
  phaseName: string,
  context: Record<string, unknown>,
): TransitionResult {
  const phase = getPhaseByName(workflow, phaseName);
  if (!phase) return null;

  const transitions = getPhaseTransitions(phase);

  for (const transition of transitions) {
    if (transition.auto) {
      return { transition, targetPhase: transition.target };
    }

    if (transition.when) {
      const matches = evaluateGuard(transition.when, context);
      if (matches) {
        return { transition, targetPhase: transition.target };
      }
    }
  }

  return null;
}
