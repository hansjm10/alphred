import { RouteLoadingBoundary } from '../ui/route-loading-boundary';

export default function WorkflowsLoading() {
  return <RouteLoadingBoundary title="Loading workflows" message="Fetching version catalog and draft state..." />;
}

