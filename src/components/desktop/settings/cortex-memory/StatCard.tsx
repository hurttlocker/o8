'use client';

export function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div style={{
      paddingTop: 16,
      paddingBottom: 16,
      paddingLeft: 16,
      paddingRight: 16,
      background: 'var(--t-bg-card, #f8fafc)',
      borderRadius: 12,
      border: '1px solid var(--t-border, #e2e8f0)',
    }}>
      <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--t-text, #0f172a)', letterSpacing: '-0.02em' }}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
      <div style={{ fontSize: 12, color: 'var(--t-text-muted, #94a3b8)', marginTop: 2 }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--t-text-muted, #94a3b8)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}
