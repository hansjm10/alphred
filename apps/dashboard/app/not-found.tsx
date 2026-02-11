import Link from 'next/link';
import { DASHBOARD_NOT_FOUND_CONTENT } from './not-found-content';

export default function NotFound() {
  return (
    <div className="app">
      <main>
        <section className="status-panel">
          <h2>{DASHBOARD_NOT_FOUND_CONTENT.title}</h2>
          <p>{DASHBOARD_NOT_FOUND_CONTENT.message}</p>
          <Link className="state-link" href="/">
            {DASHBOARD_NOT_FOUND_CONTENT.homeLabel}
          </Link>
        </section>
      </main>
    </div>
  );
}
