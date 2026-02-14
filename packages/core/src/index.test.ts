import { describe, expect, it } from 'vitest';
import * as core from './index.js';

describe('core index exports', () => {
  it('re-exports workflow helpers and state machine helpers', () => {
    expect(typeof core.getPhaseByName).toBe('function');
    expect(typeof core.getPhaseTransitions).toBe('function');
    expect(typeof core.getFirstPhase).toBe('function');
    expect(typeof core.canTransitionRun).toBe('function');
    expect(typeof core.evaluateTransitions).toBe('function');
    expect(typeof core.runPhase).toBe('function');
    expect(typeof core.createSqlWorkflowPlanner).toBe('function');
    expect(typeof core.createSqlWorkflowExecutor).toBe('function');
  });
});
