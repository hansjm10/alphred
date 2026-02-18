import { RouteLoadingBoundary } from '../../../ui/route-loading-boundary';

export default function RunWorktreeLoading() {
  return <RouteLoadingBoundary title="Loading worktree" message="Preparing changed-file explorer..." />;
}
