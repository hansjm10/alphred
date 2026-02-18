import { notFound } from 'next/navigation';
import { canServeTestRoutes } from '../test-routes-gate';
import { Card } from '../../ui/primitives';

const SLOW_ROUTE_DELAY_MS = 1500;

export const dynamic = 'force-dynamic';

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export default async function SlowPage() {
  if (!canServeTestRoutes()) {
    notFound();
  }

  await sleep(SLOW_ROUTE_DELAY_MS);

  return (
    <div className="page-stack">
      <Card title="Slow dashboard page">
        <p>This route intentionally delays rendering to exercise loading fallback behavior.</p>
      </Card>
    </div>
  );
}
