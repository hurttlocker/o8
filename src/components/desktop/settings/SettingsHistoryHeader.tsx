'use client';
import { ColumnHeaderStrip } from '../shell/ColumnHeaderStrip';
import { HeaderIconPill } from '../shell/HeaderIconPill';

export function SettingsHistoryHeader({ canBack, canForward, back, forward, onClose }: {
  canBack: boolean; canForward: boolean; back: () => void; forward: () => void; onClose?: () => void;
}) {
  return <ColumnHeaderStrip drag bottomHairline={false}
    left={<>{([-1, 1] as const).map(direction => <HeaderIconPill key={direction}
      label={direction === -1 ? 'Back' : 'Forward'} yNudge={0}
      disabled={direction === -1 ? !canBack && !onClose : !canForward}
      onClick={direction === -1 ? canBack ? back : onClose : forward}
      icon={<svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={direction === -1 ? 'M19 12H5m6-6-6 6 6 6' : 'M5 12h14m-6-6 6 6-6 6'} /></svg>} />)}</>}
    center={<span style={{ fontSize: 12, fontWeight: 300, color: 'var(--t-text-muted)' }}>Settings</span>}
    right={onClose ? <button type="button" onClick={onClose} aria-label="Back to workspace"
      style={{ border: 0, background: 'transparent', color: 'var(--t-text-muted)', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 300, fontSize: 11, minHeight: 26, paddingLeft: 8, paddingRight: 8 }}>Close Settings</button> : null} />;
}
