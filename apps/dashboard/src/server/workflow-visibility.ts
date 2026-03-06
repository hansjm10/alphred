import { DEFAULT_STORY_BREAKDOWN_TREE_KEY } from './dashboard-default-workflows';
import { DashboardIntegrationError } from './dashboard-errors';

const hiddenWorkflowTreeKeys = new Set([DEFAULT_STORY_BREAKDOWN_TREE_KEY]);

export function isHiddenWorkflowTreeKey(treeKey: string): boolean {
  return hiddenWorkflowTreeKeys.has(treeKey);
}

export function assertWorkflowTreeIsPublic(treeKey: string): void {
  if (!isHiddenWorkflowTreeKey(treeKey)) {
    return;
  }

  throw new DashboardIntegrationError('not_found', `Workflow tree "${treeKey}" was not found.`, {
    status: 404,
  });
}
