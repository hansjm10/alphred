import { env } from 'node:process';
import Link from 'next/link';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default function TestRoutesIndexPage() {
  const buildHasTestRoutes = process.env.NEXT_PUBLIC_ALPHRED_DASHBOARD_TEST_ROUTES_BUILD === '1';
  if (!buildHasTestRoutes || env.ALPHRED_DASHBOARD_TEST_ROUTES !== '1') {
    notFound();
  }

  return (
    <div className="app">
      <main>
        <section className="status-panel">
          <h2>Dashboard test routes</h2>
          <p>These routes exist only to support dashboard e2e fallback coverage.</p>
          <Link className="state-link" href="/test/slow" prefetch={false}>
            Open slow dashboard route
          </Link>
          <Link className="state-link" href="/test/error" prefetch={false}>
            Open error dashboard route
          </Link>
        </section>
      </main>
    </div>
  );
}
