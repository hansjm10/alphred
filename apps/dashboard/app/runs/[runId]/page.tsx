import { notFound } from 'next/navigation';
import type { DashboardRepositoryState, DashboardRunDetail } from '../../../src/server/dashboard-contracts';
import { DashboardIntegrationError } from '../../../src/server/dashboard-errors';
import { loadDashboardRepositories } from '../../repositories/load-dashboard-repositories';
import { loadDashboardRunDetail } from '../load-dashboard-runs';
import { RunDetailContent } from './run-detail-content';

type RunDetailPageProps = Readonly<{
  runDetail?: DashboardRunDetail;
  repositories?: readonly DashboardRepositoryState[];
  enableRealtime?: boolean;
  params: Promise<{
    runId: string;
  }>;
}>;

function parseRunId(value: string): number | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return null;
  }

  return parsed;
}

export default async function RunDetailPage({
  params,
  runDetail,
  repositories,
  enableRealtime = true,
}: RunDetailPageProps) {
  const { runId } = await params;
  const parsedRunId = parseRunId(runId);
  if (parsedRunId === null) {
    notFound();
  }

  let detail: DashboardRunDetail;
  try {
    detail = runDetail ?? (await loadDashboardRunDetail(parsedRunId));
  } catch (error) {
    if (error instanceof DashboardIntegrationError && error.code === 'not_found') {
      notFound();
    }

    throw error;
  }

  const resolvedRepositories = repositories ?? (await loadDashboardRepositories());

  return (
    <RunDetailContent
      initialDetail={detail}
      repositories={resolvedRepositories}
      enableRealtime={enableRealtime}
    />
  );
}
