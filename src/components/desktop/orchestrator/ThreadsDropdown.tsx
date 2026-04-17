'use client';

import { useRef } from 'react';

export function ThreadsDropdown(props: {
  historyOpen: boolean;
  agentsOpen: boolean;
  missionOpen: boolean;
  onToggleHistory: () => void;
  onToggleAgents: () => void;
  onToggleMission: () => void;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const menuItem = (label: string, active: boolean, onClick: () => void) => (
    <button
      type="button"
      onClick={() => { detailsRef.current?.removeAttribute('open'); onClick(); }}
      style={{
        height: 28, paddingTop: 0, paddingRight: 10, paddingBottom: 0, paddingLeft: 10, borderWidth: 0,
        background: active ? 'rgba(108, 175, 255, 0.14)' : 'transparent', color: active ? 'rgba(160, 209, 255, 0.98)' : 'rgba(255, 255, 255, 0.78)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, cursor: 'pointer', fontSize: 12, fontWeight: 400,
        fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
      }}
    >
      <span>{label}</span>
      <span style={{ fontSize: 11, color: active ? 'rgba(160, 209, 255, 0.88)' : 'rgba(255, 255, 255, 0.42)' }}>{active ? 'Open' : 'Closed'}</span>
    </button>
  );

  return (
    <details ref={detailsRef} style={{ position: 'relative', flexShrink: 0 }}>
      <summary
        style={{
          height: 26, paddingTop: 0, paddingRight: 9, paddingBottom: 0, paddingLeft: 9, borderRadius: 8, borderWidth: 1, borderStyle: 'solid',
          borderColor: 'rgba(255, 255, 255, 0.18)', background: 'transparent', color: 'rgba(255, 255, 255, 0.78)', display: 'inline-flex',
          alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12, fontWeight: 500, listStyle: 'none',
          fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
        }}
      >
        <span>Threads</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </summary>
      <div
        style={{
          position: 'absolute', top: 30, right: 0, width: 164, paddingTop: 4, paddingRight: 4, paddingBottom: 4, paddingLeft: 4, borderRadius: 10,
          borderWidth: 1, borderStyle: 'solid', borderColor: 'rgba(255, 255, 255, 0.18)', background: 'rgba(33, 38, 46, 0.72)',
          backdropFilter: 'blur(18px) saturate(1.3)', boxShadow: '0 14px 32px rgba(0, 0, 0, 0.22)', display: 'flex', flexDirection: 'column', gap: 2, zIndex: 20,
        }}
      >
        {menuItem('History', props.historyOpen, props.onToggleHistory)}
        {menuItem('Agents', props.agentsOpen, props.onToggleAgents)}
        {menuItem('Mission', props.missionOpen, props.onToggleMission)}
      </div>
    </details>
  );
}
