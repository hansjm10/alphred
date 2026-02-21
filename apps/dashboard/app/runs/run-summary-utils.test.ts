import { describe, expect, it } from 'vitest';
import type { DashboardRunSummary } from '../../src/server/dashboard-contracts';
import { sortRunsForDashboard } from './run-summary-utils';

function createRunSummary(overrides: Partial<DashboardRunSummary>): DashboardRunSummary {
  return {
    id: overrides.id ?? 1,
    tree: overrides.tree ?? {
      id: 1,
      treeKey: 'demo-tree',
      version: 1,
      name: 'Demo Tree',
    },
    repository: overrides.repository ?? null,
    status: overrides.status ?? 'pending',
    startedAt: overrides.startedAt ?? null,
    completedAt: overrides.completedAt ?? null,
    createdAt: overrides.createdAt ?? '2026-02-18T00:00:00.000Z',
    nodeSummary: overrides.nodeSummary ?? {
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      cancelled: 0,
    },
  };
}

describe('sortRunsForDashboard', () => {
  it('sorts active runs first, then failed, then completed, then cancelled', () => {
    const sorted = sortRunsForDashboard([
      createRunSummary({
        id: 10,
        status: 'completed',
        startedAt: '2026-02-18T00:00:00.000Z',
        completedAt: '2026-02-18T00:10:00.000Z',
        createdAt: '2026-02-18T00:00:00.000Z',
      }),
      createRunSummary({
        id: 11,
        status: 'failed',
        startedAt: '2026-02-18T00:05:00.000Z',
        completedAt: '2026-02-18T00:06:00.000Z',
        createdAt: '2026-02-18T00:05:00.000Z',
      }),
      createRunSummary({
        id: 12,
        status: 'running',
        startedAt: '2026-02-18T00:08:00.000Z',
        completedAt: null,
        createdAt: '2026-02-18T00:08:00.000Z',
      }),
      createRunSummary({
        id: 13,
        status: 'cancelled',
        startedAt: '2026-02-18T00:02:00.000Z',
        completedAt: '2026-02-18T00:03:00.000Z',
        createdAt: '2026-02-18T00:02:00.000Z',
      }),
    ]);

    expect(sorted.map((run) => run.id)).toEqual([12, 11, 10, 13]);
  });

  it('sorts within a tier by most recent timestamp, then by id', () => {
    const sorted = sortRunsForDashboard([
      createRunSummary({
        id: 50,
        status: 'failed',
        startedAt: '2026-02-18T00:00:00.000Z',
        completedAt: '2026-02-18T00:05:00.000Z',
        createdAt: '2026-02-18T00:00:00.000Z',
      }),
      createRunSummary({
        id: 51,
        status: 'failed',
        startedAt: '2026-02-18T00:10:00.000Z',
        completedAt: '2026-02-18T00:12:00.000Z',
        createdAt: '2026-02-18T00:10:00.000Z',
      }),
      createRunSummary({
        id: 52,
        status: 'failed',
        startedAt: '2026-02-18T00:10:00.000Z',
        completedAt: '2026-02-18T00:12:00.000Z',
        createdAt: '2026-02-18T00:10:00.000Z',
      }),
    ]);

    expect(sorted.map((run) => run.id)).toEqual([52, 51, 50]);
  });
});

