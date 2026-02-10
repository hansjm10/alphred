import { describe, it, expect } from 'vitest';
import type { RunStatus, PhaseStatus, WorkflowDefinition, GuardExpression } from './index.js';

describe('shared types', () => {
  it('should allow valid run statuses', () => {
    const statuses: RunStatus[] = ['pending', 'running', 'paused', 'completed', 'failed', 'cancelled'];
    expect(statuses).toHaveLength(6);
  });

  it('should allow valid phase statuses', () => {
    const statuses: PhaseStatus[] = ['pending', 'running', 'completed', 'failed', 'skipped'];
    expect(statuses).toHaveLength(5);
  });

  it('should type-check a workflow definition', () => {
    const workflow: WorkflowDefinition = {
      name: 'test-workflow',
      version: 1,
      phases: [
        {
          name: 'design',
          type: 'agent',
          provider: 'claude',
          prompt: 'Create a design document',
          maxRetries: 2,
          transitions: [
            { target: 'implement', priority: 1, auto: true },
          ],
        },
      ],
    };
    expect(workflow.phases).toHaveLength(1);
    expect(workflow.phases[0].name).toBe('design');
  });

  it('should type-check guard expressions', () => {
    const guard: GuardExpression = {
      logic: 'and',
      conditions: [
        { field: 'report.approved', operator: '==', value: true },
        { field: 'report.score', operator: '>=', value: 80 },
      ],
    };
    expect('logic' in guard).toBe(true);
  });
});
