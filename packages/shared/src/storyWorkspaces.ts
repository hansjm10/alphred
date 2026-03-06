export const storyWorkspaceStatuses = ['active', 'stale', 'removed'] as const;
export type StoryWorkspaceStatus = (typeof storyWorkspaceStatuses)[number];

export const storyWorkspaceStatusReasons = [
  'missing_path',
  'worktree_not_registered',
  'branch_mismatch',
  'repository_clone_missing',
  'reconcile_failed',
  'removed_state_drift',
  'cleanup_requested',
] as const;
export type StoryWorkspaceStatusReason = (typeof storyWorkspaceStatusReasons)[number];
