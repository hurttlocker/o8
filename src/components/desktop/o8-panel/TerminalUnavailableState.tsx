import { useRef, useState } from 'react';
import { TerminalIcon } from './O8PanelUtilityTabs';
import { SurfaceEmptyState } from './SurfaceEmptyState';

export function TerminalUnavailableState({ onOpenMainTerminal }: { onOpenMainTerminal?: () => Promise<void> }) {
  const openingRef = useRef(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = async () => {
    if (!onOpenMainTerminal || openingRef.current) return;
    openingRef.current = true;
    setOpening(true);
    setError(null);
    try {
      await onOpenMainTerminal();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not open the main terminal. Try again.');
    } finally {
      openingRef.current = false;
      setOpening(false);
    }
  };
  return <SurfaceEmptyState
    icon={<TerminalIcon size={18} />}
    title="Terminal unavailable"
    detail="The right-panel terminal is unavailable in this view. You can continue in the main workspace terminal."
    action={onOpenMainTerminal ? <>
      <button type="button" onClick={() => { void open(); }} disabled={opening} aria-busy={opening}
        style={{ border: '1px solid var(--t-divider)', borderRadius: 7, background: 'var(--t-input-bg)', color: 'var(--t-text)', font: 'inherit', fontSize: 12, fontWeight: 300, paddingTop: 7, paddingRight: 12, paddingBottom: 7, paddingLeft: 12, cursor: opening ? 'wait' : 'pointer' }}>
        {opening ? 'Opening terminal…' : 'Open main terminal'}
      </button>
      {error ? <div role="alert" style={{ maxWidth: 360, fontSize: 12, color: 'var(--t-danger, var(--t-text))' }}>{error}</div> : null}
    </> : undefined}
  />;
}
