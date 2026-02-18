import { RouteLoadingBoundary } from '../ui/route-loading-boundary';

export default function RepositoriesLoading() {
  return <RouteLoadingBoundary title="Loading repositories" message="Checking clone status and sync state..." />;
}
