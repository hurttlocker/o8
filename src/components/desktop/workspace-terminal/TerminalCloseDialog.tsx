'use client';

import { useEffect, useRef, useState } from 'react';
import { FloatingDialog } from '../FloatingDialog';
import { RamsButton } from '../settings/shared';
import { subscribeTerminalCloseConfirm, type TerminalCloseRequest } from './terminal-close-confirm';

export function TerminalCloseDialog() {
  const [request, setRequest] = useState<TerminalCloseRequest | null>(null);
  const pendingRef = useRef<TerminalCloseRequest | null>(null);
  useEffect(() => {
    const stop = subscribeTerminalCloseConfirm((next) => { pendingRef.current = next; setRequest(next); });
    return () => { stop(); pendingRef.current?.resolve(false); pendingRef.current = null; };
  }, []);
  if (!request) return null;
  const finish = (confirmed: boolean) => { pendingRef.current = null; setRequest(null); request.resolve(confirmed); };
  const plural = request.count > 1;
  return <FloatingDialog title={`Close ${request.tab.label}?`} onClose={() => finish(false)}>
    <h2 style={{ margin: 0, fontSize: 18, fontWeight: 400, letterSpacing: '-0.2px', overflowWrap: 'anywhere' }}>Close {request.tab.label}?</h2>
    <p style={{ marginTop: 12, marginBottom: 20, fontSize: 13, fontWeight: 300, lineHeight: 1.55, color: 'var(--t-text-secondary)' }}>{plural ? 'This removes these terminals from your workspace. New terminals start fresh; their commands and live state won’t reopen like chats. Saved sessions may still be available in Sessions.' : 'This removes the terminal from your workspace. A new terminal starts fresh; its commands and live state won’t reopen like a chat. A saved session may still be available in Sessions.'}</p>
    {request.tab.cliAgent && request.tab.cliAgent !== 'shell' ? <p style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--t-text-muted)' }}>You can resume this CLI conversation only if the CLI saved it.</p> : null}
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><RamsButton variant="ghost" onClick={() => finish(false)}>{plural ? 'Keep terminals' : 'Keep terminal'}</RamsButton><RamsButton variant="danger" onClick={() => finish(true)}>{plural ? 'Close terminals' : 'Close terminal'}</RamsButton></div>
  </FloatingDialog>;
}
