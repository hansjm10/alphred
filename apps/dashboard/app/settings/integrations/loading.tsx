import { RouteLoadingBoundary } from '../../ui/route-loading-boundary';

export default function IntegrationsLoading() {
  return <RouteLoadingBoundary title="Loading integrations" message="Checking GitHub authentication status..." />;
}
