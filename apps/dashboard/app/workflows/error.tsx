'use client';

import { createRouteErrorBoundary } from '../ui/route-error-boundary';

const WorkflowsError = createRouteErrorBoundary({
  title: 'Workflows unavailable',
  message: 'Unable to load workflow catalog data.',
  logPrefix: 'Workflows route error:',
});

export default WorkflowsError;

