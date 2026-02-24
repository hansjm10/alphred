import type { RunStatus, PhaseStatus } from '@alphred/shared';

const validRunTransitions: Record<RunStatus, RunStatus[]> = {
  pending: ['running', 'cancelled'],
  running: ['completed', 'failed', 'cancelled', 'paused'],
  paused: ['running', 'cancelled'],
  completed: [],
  failed: ['running'],
  cancelled: [],
};

const validPhaseTransitions: Record<PhaseStatus, PhaseStatus[]> = {
  pending: ['running', 'skipped'],
  running: ['completed', 'failed'],
  completed: [],
  failed: ['running'],
  skipped: [],
};

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return validRunTransitions[from].includes(to);
}

export function canTransitionPhase(from: PhaseStatus, to: PhaseStatus): boolean {
  return validPhaseTransitions[from].includes(to);
}

export function transitionRun(current: RunStatus, next: RunStatus): RunStatus {
  if (!canTransitionRun(current, next)) {
    throw new Error(`Invalid run transition: ${current} -> ${next}`);
  }
  return next;
}

export function transitionPhase(current: PhaseStatus, next: PhaseStatus): PhaseStatus {
  if (!canTransitionPhase(current, next)) {
    throw new Error(`Invalid phase transition: ${current} -> ${next}`);
  }
  return next;
}

export function isRunTerminal(status: RunStatus): boolean {
  return validRunTransitions[status].length === 0;
}

export function isPhaseTerminal(status: PhaseStatus): boolean {
  return status === 'completed' || status === 'skipped';
}
