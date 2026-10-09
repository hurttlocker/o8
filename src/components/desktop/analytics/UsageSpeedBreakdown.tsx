import { money } from './history-view';

export function UsageSpeedBreakdown({ cost, fast, premium, unpriced }: { cost: number; fast: number; premium: number; unpriced: number }) {
  const standard = Math.max(0, cost - fast);
  return <section aria-label="Cost by speed" style={{ display: 'grid', alignContent: 'start', gap: 14 }}>
    <h2 style={{ margin: 0, fontSize: 13.5, fontWeight: 400 }}>Cost by speed</h2>
    <div role="img" aria-label={`Standard ${money(standard)}, Fast ${money(fast)}`} style={{ display: 'flex', height: 6, borderRadius: 3,
      overflow: 'hidden', background: 'var(--t-divider-subtle)' }}>
      <span style={{ width: `${cost ? standard / cost * 100 : 0}%`, background: 'var(--t-text-secondary)' }} />
      <span style={{ width: `${cost ? fast / cost * 100 : 0}%`, background: 'var(--t-accent)' }} />
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
      {[{ label: 'Standard', value: standard, color: 'var(--t-text-secondary)' }, { label: 'Fast', value: fast, color: 'var(--t-accent)' }].map(item =>
        <div key={item.label} style={{ display: 'grid', gap: 6 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--t-text-secondary)' }}>
            <span style={{ width: 6, height: 6, borderRadius: 2, background: item.color }} />{item.label}
          </span>
          <span style={{ fontSize: 20, fontWeight: 400, letterSpacing: '-0.3px', fontVariantNumeric: 'tabular-nums' }}>{money(item.value)}</span>
          <span style={{ fontSize: 9.5, color: 'var(--t-text-muted)' }}>{cost ? `${(item.value / cost * 100).toFixed(1)}%` : '0%'} of priced cost</span>
        </div>)}
    </div>
    <div style={{ display: 'grid', gap: 5, fontSize: 11, paddingTop: 2 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <span style={{ color: 'var(--t-text-secondary)' }}>Premium estimate</span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{money(premium)}</span>
      </div>
      <span style={{ fontSize: 9.5, color: 'var(--t-text-muted)', lineHeight: 1.45 }}>Extra cost of Fast, already included above.{unpriced ? ' Requests without known prices are excluded.' : ''}</span>
    </div>
  </section>;
}
