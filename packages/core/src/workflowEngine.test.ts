import { describe, it, expect } from 'vitest';
import type { WorkflowDefinition } from '@alphred/shared';
import { evaluateTransitions } from './workflowEngine.js';

const testWorkflow: WorkflowDefinition = {
  name: 'test-workflow',
  version: 1,
  phases: [
    {
      name: 'design',
      type: 'agent',
      provider: 'claude',
      prompt: 'Create design',
      transitions: [
        { target: 'implement', priority: 1, auto: true },
      ],
    },
    {
      name: 'implement',
      type: 'agent',
      provider: 'codex',
      prompt: 'Implement design',
      transitions: [
        {
          target: 'design',
          priority: 1,
          when: { field: 'needs_revision', operator: '==', value: true },
        },
        { target: 'review', priority: 2, auto: true },
      ],
    },
    {
      name: 'review',
      type: 'agent',
      provider: 'claude',
      prompt: 'Review implementation',
      transitions: [],
    },
  ],
};

describe('workflowEngine', () => {
  it('should evaluate auto transitions', () => {
    const result = evaluateTransitions(testWorkflow, 'design', {});
    expect(result).not.toBeNull();
    expect(result!.targetPhase).toBe('implement');
  });

  it('should evaluate guard-based transitions', () => {
    const result = evaluateTransitions(testWorkflow, 'implement', {
      needs_revision: true,
    });
    expect(result).not.toBeNull();
    expect(result!.targetPhase).toBe('design');
  });

  it('should fall through to auto when guard does not match', () => {
    const result = evaluateTransitions(testWorkflow, 'implement', {
      needs_revision: false,
    });
    expect(result).not.toBeNull();
    expect(result!.targetPhase).toBe('review');
  });

  it('should return null for unknown phase', () => {
    const result = evaluateTransitions(testWorkflow, 'nonexistent', {});
    expect(result).toBeNull();
  });

  it('should return null when no transitions match', () => {
    const result = evaluateTransitions(testWorkflow, 'review', {});
    expect(result).toBeNull();
  });
});
