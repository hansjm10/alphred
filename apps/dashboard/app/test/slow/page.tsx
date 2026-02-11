import { notFound } from 'next/navigation';
import { canServeTestRoutes } from '../test-routes-gate';

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
    <div className="app">
      <main>
        <section className="status-panel">
          <h2>Slow dashboard page</h2>
          <p>This route intentionally delays rendering to exercise loading fallback behavior.</p>
        </section>
      </main>
    </div>
  );
}
