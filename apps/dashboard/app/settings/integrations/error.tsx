'use client';

import { createRouteErrorBoundary } from '../../ui/route-error-boundary';

const IntegrationsError = createRouteErrorBoundary({
  title: 'Integrations unavailable',
  message: 'Unable to load integration authentication status.',
  logPrefix: 'Integrations route error:',
});

export default IntegrationsError;
