import type { WorkflowDefinition, PhaseDefinition, Transition } from '@alphred/shared';

export function getPhaseByName(workflow: WorkflowDefinition, name: string): PhaseDefinition | undefined {
  return workflow.phases.find(p => p.name === name);
}

export function getPhaseTransitions(phase: PhaseDefinition): Transition[] {
  return [...phase.transitions].sort((a, b) => a.priority - b.priority);
}

export function getFirstPhase(workflow: WorkflowDefinition): PhaseDefinition | undefined {
  return workflow.phases[0];
}
