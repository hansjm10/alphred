import { RouteLoadingBoundary } from '../../ui/route-loading-boundary';

export default function RunDetailLoading() {
  return <RouteLoadingBoundary title="Loading run detail" message="Fetching timeline and node lifecycle..." />;
}
