import type { ReactNode } from 'react';

export function SettingsAdvanced({ children, label = 'Advanced', description }: {
  children?: ReactNode; label?: string; description: string;
}) {
  return (
    <details style={{ marginTop: 28 }}>
      <summary data-settings-section={label} style={{ cursor: 'pointer', color: 'var(--t-text)', fontSize: 15, fontWeight: 600, paddingTop: 10, paddingBottom: 10 }}>
        {label}
        <span style={{ display: 'block', marginTop: 6, color: 'var(--t-text-muted)', fontSize: 12, fontWeight: 400, lineHeight: 1.5 }}>{description}</span>
      </summary>
      {children}
    </details>
  );
}
