export default function Loading() {
  return (
    <div className="app">
      <main>
        <section className="status-panel">
          <h2>Loading dashboard</h2>
          <output role="status" aria-live="polite">
            Preparing workflow run data...
          </output>
        </section>
      </main>
    </div>
  );
}

