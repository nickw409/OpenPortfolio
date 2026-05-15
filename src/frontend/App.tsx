import { useEffect, useState } from 'react';

type Health = { status: string };

export function App() {
  const [backend, setBackend] = useState<'unknown' | 'ok' | 'down'>('unknown');

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json() as Promise<Health>)
      .then((h) => setBackend(h.status === 'ok' ? 'ok' : 'down'))
      .catch(() => setBackend('down'));
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', maxWidth: 720 }}>
      <h1>OpenPortfolio</h1>
      <p>Local-first portfolio tracker. Scaffolding only — see docs/WORKSTREAMS.md.</p>
      <p>Backend: {backend}</p>
    </main>
  );
}
