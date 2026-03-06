import {
  DEFAULT_STORY_BREAKDOWN_NODE_KEY,
  DEFAULT_STORY_BREAKDOWN_TREE_KEY,
} from './dashboard-default-workflows';

export type StoryBreakdownPlannerConfig = {
  treeKey: string;
  nodeKey: string;
};

function normalizeConfiguredValue(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

export function resolveStoryBreakdownPlannerConfig(environment: NodeJS.ProcessEnv): StoryBreakdownPlannerConfig {
  return {
    treeKey: normalizeConfiguredValue(
      environment.ALPHRED_DASHBOARD_STORY_BREAKDOWN_TREE_KEY,
      DEFAULT_STORY_BREAKDOWN_TREE_KEY,
    ),
    nodeKey: normalizeConfiguredValue(
      environment.ALPHRED_DASHBOARD_STORY_BREAKDOWN_NODE_KEY,
      DEFAULT_STORY_BREAKDOWN_NODE_KEY,
    ),
  };
}

export function resolveHiddenWorkflowTreeKeys(environment: NodeJS.ProcessEnv): Set<string> {
  const plannerConfig = resolveStoryBreakdownPlannerConfig(environment);
  return new Set([DEFAULT_STORY_BREAKDOWN_TREE_KEY, plannerConfig.treeKey]);
}
