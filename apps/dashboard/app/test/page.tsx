import Link from 'next/link';
import { notFound } from 'next/navigation';
import { canServeTestRoutes } from './test-routes-gate';
import { Card } from '../ui/primitives';

export const dynamic = 'force-dynamic';

export default function TestRoutesIndexPage() {
  if (!canServeTestRoutes()) {
    notFound();
  }

  return (
    <div className="page-stack">
      <Card title="Dashboard test routes">
        <p>These routes exist only to support dashboard e2e fallback coverage.</p>
        <div className="action-row">
          <Link className="button-link button-link--secondary" href="/test/slow" prefetch={false}>
            Open slow dashboard route
          </Link>
          <Link className="button-link button-link--secondary" href="/test/error" prefetch={false}>
            Open error dashboard route
          </Link>
        </div>
      </Card>
    </div>
  );
}
