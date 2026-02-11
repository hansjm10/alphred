import Link from 'next/link';
import { notFound } from 'next/navigation';
import { canServeTestRoutes } from './test-routes-gate';

export const dynamic = 'force-dynamic';

export default function TestRoutesIndexPage() {
  if (!canServeTestRoutes()) {
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
