'use client';

export default function PluginsTab() {
  return <section aria-label="Plugins" style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
    <p style={{ margin: 0, color: 'var(--t-text-secondary)', fontSize: 14, lineHeight: 1.6 }}>Plugins add features and interfaces to o8.</p>
    <div style={{ border: '1px solid var(--t-divider)', borderRadius: 14, paddingTop: 32, paddingBottom: 32, paddingLeft: 28, paddingRight: 28 }}>
      <h2 style={{ marginTop: 0, marginBottom: 8, color: 'var(--t-text)', fontSize: 18, fontWeight: 500 }}>No plugins available yet</h2>
      <p style={{ margin: 0, color: 'var(--t-text-muted)', fontSize: 13, lineHeight: 1.6 }}>Reusable agent instructions live in Skills.</p>
    </div>
  </section>;
}
