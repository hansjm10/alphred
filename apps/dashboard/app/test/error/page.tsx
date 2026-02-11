import { notFound } from 'next/navigation';
import { canServeTestRoutes } from '../test-routes-gate';

export const dynamic = 'force-dynamic';

export default function ErrorTestPage() {
  if (!canServeTestRoutes()) {
    notFound();
  }

  throw new Error('Dashboard test route error');
}
