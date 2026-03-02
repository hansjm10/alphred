import { describe, expect, it } from 'vitest';
import { workItemStatusesByType, workItemTypes, type WorkItemType } from '@alphred/shared';
import {
  canParentChildWorkItemTypes,
  canTransitionWorkItem,
  validateParentChildWorkItemTypes,
  validateTransition,
} from './workItemLifecycle.js';

function edge(from: string, to: string): string {
  return `${from}::${to}`;
}

const expectedTransitionEdgesByType: Record<WorkItemType, ReadonlySet<string>> = {
  epic: new Set([
    edge('Draft', 'Approved'),
    edge('Approved', 'InProgress'),
    edge('InProgress', 'Blocked'),
    edge('Blocked', 'InProgress'),
    edge('InProgress', 'InReview'),
    edge('InReview', 'InProgress'),
    edge('InReview', 'Done'),
  ]),
  feature: new Set([
    edge('Draft', 'Approved'),
    edge('Approved', 'InProgress'),
    edge('InProgress', 'Blocked'),
    edge('Blocked', 'InProgress'),
    edge('InProgress', 'InReview'),
    edge('InReview', 'InProgress'),
    edge('InReview', 'Done'),
  ]),
  story: new Set([
    edge('Draft', 'NeedsBreakdown'),
    edge('NeedsBreakdown', 'BreakdownProposed'),
    edge('BreakdownProposed', 'Approved'),
    edge('Approved', 'InProgress'),
    edge('InProgress', 'InReview'),
    edge('InReview', 'InProgress'),
    edge('InReview', 'Done'),
  ]),
  task: new Set([
    edge('Draft', 'Ready'),
    edge('Ready', 'InProgress'),
    edge('InProgress', 'Blocked'),
    edge('Blocked', 'InProgress'),
    edge('InProgress', 'InReview'),
    edge('InReview', 'InProgress'),
    edge('InReview', 'Done'),
  ]),
};

describe('workItemLifecycle', () => {
  describe('validateTransition', () => {
    for (const type of workItemTypes) {
      it(`is exhaustive for type="${type}"`, () => {
        const statuses = workItemStatusesByType[type] as readonly string[];
        const edges = expectedTransitionEdgesByType[type];

        for (const from of statuses) {
          for (const to of statuses) {
            const expected = edges.has(edge(from, to));
            expect(canTransitionWorkItem({ type, from, to })).toBe(expected);

            if (expected) {
              expect(() => validateTransition({ type, from, to })).not.toThrow();
            } else {
              expect(() => validateTransition({ type, from, to })).toThrow('Invalid work item transition');
            }
          }
        }
      });
    }

    it('throws a typed error when from status is not valid for type', () => {
      expect(() => validateTransition({ type: 'story', from: 'Ready', to: 'NeedsBreakdown' })).toThrow(
        'Unknown work item status',
      );
    });

    it('throws a typed error when to status is not valid for type', () => {
      expect(() => validateTransition({ type: 'task', from: 'Draft', to: 'NeedsBreakdown' })).toThrow(
        'Unknown work item status',
      );
    });

    it('returns false for unknown statuses', () => {
      expect(canTransitionWorkItem({ type: 'task', from: 'nope', to: 'Draft' })).toBe(false);
      expect(canTransitionWorkItem({ type: 'task', from: 'Draft', to: 'nope' })).toBe(false);
    });
  });

  describe('parent/child type constraints', () => {
    it('only allows epic->feature->story->task (immediate parent)', () => {
      const expectedAllowed = new Set<string>([
        'epic::feature',
        'feature::story',
        'story::task',
      ]);

      for (const parentType of workItemTypes) {
        for (const childType of workItemTypes) {
          const expected = expectedAllowed.has(`${parentType}::${childType}`);
          expect(canParentChildWorkItemTypes(parentType, childType)).toBe(expected);
          if (expected) {
            expect(() => validateParentChildWorkItemTypes(parentType, childType)).not.toThrow();
          } else {
            expect(() => validateParentChildWorkItemTypes(parentType, childType)).toThrow('Invalid work item parent/child');
          }
        }
      }
    });
  });
});

