import { ShieldCheck } from '../../../lucide-shims';

export function DispatchLockStrip({ activeLocks, sessionBound }: { activeLocks: number; sessionBound: number }) {
  return (
    <div style={{ marginTop: 7, display: 'flex', alignItems: 'center', gap: 8, minHeight: 28, borderBottom: '1px solid var(--t-divider-subtle)', color: 'var(--t-text-muted)', fontSize: 10.5, lineHeight: '14px' }}>
      <ShieldCheck size={14} strokeWidth={2} style={{ color: 'var(--t-accent)', flexShrink: 0 }} />
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Codex-only dispatch lock</span>
      <span style={{ color: 'var(--t-text-faint)', flexShrink: 0 }}>{activeLocks} locks - {sessionBound} open</span>
    </div>
  );
}
