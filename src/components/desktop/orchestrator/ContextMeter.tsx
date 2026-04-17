'use client';

import { formatTokens } from '@/lib/util/format-tokens';

const CONTEXT_LIMIT = 1_000_000;
const meterLabel = (value: number) => formatTokens(value).replace(/K$/u, 'k');

export function ContextMeter({ tokenCount, runningTotal, onClick }: { tokenCount: number; runningTotal: number; onClick: () => void }) {
  const percent = Math.round((Math.max(0, Math.min(CONTEXT_LIMIT, runningTotal)) / CONTEXT_LIMIT) * 100);
  const tone = percent >= 85 ? 'critical' : percent >= 60 ? 'warning' : 'idle';
  const label = `${meterLabel(runningTotal)} / 1M · ${percent}%`;
  const fill = Math.max(0, Math.min(8, Math.ceil((percent / 100) * 8)));
  const fillColor = tone === 'critical' ? '#FF5A1F' : tone === 'warning' ? 'var(--t-text-muted)' : 'var(--t-text-faint)';

  return (
    <button
      type="button"
      onClick={onClick}
      title={tokenCount > 0 ? `Context usage ${label} · +${meterLabel(tokenCount)} last turn` : `Context usage ${label}`}
      style={{
        height: 26, maxWidth: 280, paddingTop: 0, paddingRight: 8, paddingBottom: 0, paddingLeft: 8, borderRadius: 8, borderWidth: 1, borderStyle: 'solid',
        borderColor: tone === 'critical' ? '#FF5A1F' : 'var(--t-border)', background: 'transparent',
        color: tone === 'critical' ? '#FF5A1F' : 'var(--t-text-muted)',
        display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', minWidth: 0, fontSize: 11.5, fontWeight: 400, letterSpacing: '0.01em',
        whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', fontFamily: "'iA Writer Mono', 'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, monospace",
      }}
    >
      <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 999, flexShrink: 0, background: tone === 'idle' ? 'var(--t-text-faint)' : '#FF5A1F' }} />
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
        {Array.from({ length: 8 }, (_, segment) => <span key={segment} aria-hidden="true" style={{ width: 8, height: 6, borderRadius: 2, background: segment < fill ? fillColor : 'var(--t-divider-subtle)' }} />)}
      </span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
    </button>
  );
}
