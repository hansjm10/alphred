import { env } from 'node:process';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default function ErrorTestPage() {
  const buildHasTestRoutes = process.env.NEXT_PUBLIC_ALPHRED_DASHBOARD_TEST_ROUTES_BUILD === '1';
  if (!buildHasTestRoutes || env.ALPHRED_DASHBOARD_TEST_ROUTES !== '1') {
    notFound();
  }

  throw new Error('Dashboard test route error');
}
