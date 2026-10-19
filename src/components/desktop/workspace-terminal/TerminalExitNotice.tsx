import type { CSSProperties } from 'react';
import type { TerminalExitState } from '@/lib/terminal/exit-state';

const actionStyle: CSSProperties = {
  border: '1px solid var(--t-divider)', borderRadius: 6, background: 'var(--t-input-bg)',
  color: 'var(--t-text)', font: 'inherit', fontWeight: 300, fontSize: 11,
  paddingTop: 4, paddingRight: 8, paddingBottom: 4, paddingLeft: 8, cursor: 'pointer',
};

export function TerminalExitNotice({ state, onNewShell, onClose }: {
  state: TerminalExitState;
  onNewShell?: () => void;
  onClose?: () => void;
}) {
  return <div data-terminal-exit="true" role="status" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, flexShrink: 0, paddingTop: 8, paddingRight: 12, paddingBottom: 8, paddingLeft: 12, borderBottom: '1px solid var(--t-divider)', color: 'var(--t-text-secondary)', fontFamily: 'var(--font-sans-system)', fontSize: 11, fontWeight: 300 }}>
    <span style={{ flex: 1 }}>Session ended. {state.exitCode === null ? 'Exit status unknown' : `Exited with code ${state.exitCode}`}.</span>
    {onNewShell ? <button type="button" style={actionStyle} onClick={onNewShell} title="Open a new shell in this folder; keep this ended transcript">New shell</button> : null}
    {onClose ? <button type="button" style={actionStyle} onClick={onClose}>Close</button> : null}
  </div>;
}
