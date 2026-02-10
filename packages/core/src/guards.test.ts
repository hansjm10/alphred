import { describe, it, expect } from 'vitest';
import { evaluateGuard } from './guards.js';

describe('guards', () => {
  it('should evaluate simple equality', () => {
    const result = evaluateGuard(
      { field: 'approved', operator: '==', value: true },
      { approved: true },
    );
    expect(result).toBe(true);
  });

  it('should evaluate inequality', () => {
    const result = evaluateGuard(
      { field: 'status', operator: '!=', value: 'draft' },
      { status: 'published' },
    );
    expect(result).toBe(true);
  });

  it('should evaluate numeric comparisons', () => {
    expect(evaluateGuard(
      { field: 'score', operator: '>=', value: 80 },
      { score: 85 },
    )).toBe(true);

    expect(evaluateGuard(
      { field: 'score', operator: '<', value: 50 },
      { score: 85 },
    )).toBe(false);
  });

  it('should resolve dotted field paths', () => {
    const result = evaluateGuard(
      { field: 'report.quality.score', operator: '>', value: 70 },
      { report: { quality: { score: 95 } } },
    );
    expect(result).toBe(true);
  });

  it('should evaluate AND logic', () => {
    const result = evaluateGuard(
      {
        logic: 'and',
        conditions: [
          { field: 'approved', operator: '==', value: true },
          { field: 'score', operator: '>=', value: 80 },
        ],
      },
      { approved: true, score: 90 },
    );
    expect(result).toBe(true);
  });

  it('should evaluate OR logic', () => {
    const result = evaluateGuard(
      {
        logic: 'or',
        conditions: [
          { field: 'approved', operator: '==', value: true },
          { field: 'score', operator: '>=', value: 80 },
        ],
      },
      { approved: false, score: 90 },
    );
    expect(result).toBe(true);
  });

  it('should return false for missing fields', () => {
    const result = evaluateGuard(
      { field: 'missing.field', operator: '==', value: true },
      { other: 'value' },
    );
    expect(result).toBe(false);
  });
});
