import type React from 'react';

export function SurfaceEmptyState({
  icon,
  title,
  detail,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <div style={{
      flex: 1,
      minHeight: 0,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 10,
      color: 'var(--t-text-muted)',
      background: 'var(--t-bg)',
      textAlign: 'center',
      padding: 24,
    }}>
      <div style={{
        width: 42,
        height: 42,
        borderRadius: 14,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--t-text-secondary)',
        background: 'var(--t-input-bg)',
        border: '1px solid var(--t-divider-subtle)',
      }}>
        {icon}
      </div>
      <div style={{ fontSize: 13.5, fontWeight: 350, letterSpacing: '-0.1px', color: 'var(--t-text)' }}>{title}</div>
      <div style={{ maxWidth: 360, fontSize: 13, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.45, color: 'var(--t-text-faint)' }}>{detail}</div>
    </div>
  );
}
