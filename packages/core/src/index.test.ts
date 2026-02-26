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
    expect(typeof core.WorkflowRunExecutionValidationError).toBe('function');
  });

  it('preserves optional cause on WorkflowRunExecutionValidationError', () => {
    const cause = new Error('upstream validation failed');
    const error = new core.WorkflowRunExecutionValidationError(
      'WORKFLOW_RUN_SINGLE_NODE_SELECTOR_NOT_EXECUTABLE',
      'Node selector was not executable.',
      {
        workflowRunId: 7,
        nodeSelector: {
          type: 'next_runnable',
        },
        cause,
      },
    );

    expect(error.name).toBe('WorkflowRunExecutionValidationError');
    expect(error.code).toBe('WORKFLOW_RUN_SINGLE_NODE_SELECTOR_NOT_EXECUTABLE');
    expect(error.workflowRunId).toBe(7);
    expect(error.nodeSelector).toEqual({
      type: 'next_runnable',
    });
    expect((error as Error & { cause?: unknown }).cause).toBe(cause);
  });
});
