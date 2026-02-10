export default function Loading() {
  return (
    <div className="app">
      <main>
        <section className="status-panel state-panel" role="status" aria-live="polite">
          <h2>Loading dashboard</h2>
          <p>Preparing workflow run data...</p>
        </section>
      </main>
    </div>
  );
}
