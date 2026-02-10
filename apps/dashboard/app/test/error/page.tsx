import { env } from 'node:process';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default function ErrorTestPage() {
  if (env.ALPHRED_DASHBOARD_TEST_ROUTES !== '1') {
    notFound();
  }

  throw new Error('Dashboard test route error');
}
