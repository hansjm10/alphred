import { notFound } from 'next/navigation';
import { cache } from 'react';
import type { DashboardRunDetail } from '../../../src/server/dashboard-contracts';
import { DashboardIntegrationError } from '../../../src/server/dashboard-errors';
import { createDashboardService } from '../../../src/server/dashboard-service';

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

export const loadDashboardRunDetail = cache(async (runIdParam: string): Promise<DashboardRunDetail> => {
  const runId = parseRunId(runIdParam);
  const service = createDashboardService();

  try {
    return await service.getWorkflowRunDetail(runId);
  } catch (error) {
    if (isNotFoundError(error)) {
      notFound();
    }

    throw error;
  }
});
