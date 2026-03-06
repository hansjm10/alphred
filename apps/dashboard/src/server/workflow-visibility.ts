import { DashboardIntegrationError } from './dashboard-errors';
import { resolveHiddenWorkflowTreeKeys } from './story-breakdown-planner-config';

export function isHiddenWorkflowTreeKey(treeKey: string, environment: NodeJS.ProcessEnv = process.env): boolean {
  return resolveHiddenWorkflowTreeKeys(environment).has(treeKey);
}

export function assertWorkflowTreeIsPublic(treeKey: string, environment: NodeJS.ProcessEnv = process.env): void {
  if (!isHiddenWorkflowTreeKey(treeKey, environment)) {
    return;
  }

  throw new DashboardIntegrationError('not_found', `Workflow tree "${treeKey}" was not found.`, {
    status: 404,
  });
}
