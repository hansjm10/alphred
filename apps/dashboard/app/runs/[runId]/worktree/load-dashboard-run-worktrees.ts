import { notFound } from 'next/navigation';
import { cache } from 'react';
import type {
  DashboardRunSummary,
  DashboardRunWorktreeMetadata,
} from '../../../../src/server/dashboard-contracts';
import { DashboardIntegrationError } from '../../../../src/server/dashboard-errors';
import { createDashboardService } from '../../../../src/server/dashboard-service';

export type DashboardRunWorktreeLoadResult = Readonly<{
  run: DashboardRunSummary;
  worktrees: readonly DashboardRunWorktreeMetadata[];
}>;

function parseRunId(runIdParam: string): number {
  const runId = Number(runIdParam);

  if (!Number.isInteger(runId) || runId < 1) {
    notFound();
  }

  return runId;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof DashboardIntegrationError && error.code === 'not_found';
}

export const loadDashboardRunWorktrees = cache(async (
  runIdParam: string,
): Promise<DashboardRunWorktreeLoadResult> => {
  const runId = parseRunId(runIdParam);
  const service = createDashboardService();

  try {
    const detail = await service.getWorkflowRunDetail(runId);

    return {
      run: detail.run,
      worktrees: detail.worktrees,
    };
  } catch (error) {
    if (isNotFoundError(error)) {
      notFound();
    }

    throw error;
  }
});
