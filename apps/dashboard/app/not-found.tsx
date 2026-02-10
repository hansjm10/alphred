import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="app">
      <main>
        <section className="status-panel state-panel">
          <h2>Page not found</h2>
          <p>The page you requested does not exist in this dashboard.</p>
          <Link className="state-link" href="/">
            Return to home
          </Link>
        </section>
      </main>
    </div>
  );
}
