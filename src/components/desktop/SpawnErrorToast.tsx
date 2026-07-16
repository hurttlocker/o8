'use client';

import { useEffect } from 'react';
import { AlertTriangle, X } from './lucide-shims';

/**
 * SpawnErrorToast — surfaces a failed New-session spawn to the operator.
 *
 * The spawn handlers used to swallow failures into console.error only, so a
 * broken spawn read as "the button does nothing" (report D3YPBP rounds 1-3 —
 * unreproducible here precisely BECAUSE the machine's error text never left
 * the ring buffer). Error-surfacing-first: show the actual message so a
 * founder's screenshot carries the diagnosis.
 */
export function SpawnErrorToast({ message, onDismiss }: {
  message: string | null;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(onDismiss, 12_000);
    return () => window.clearTimeout(timer);
  }, [message, onDismiss]);

  if (!message) return null;

  return (
    <div
      role="alert"
      style={{
        position: 'fixed',
        left: '50%',
        bottom: 48,
        transform: 'translateX(-50%)',
        zIndex: 400,
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        maxWidth: 520,
        paddingTop: 9,
        paddingRight: 12,
        paddingBottom: 9,
        paddingLeft: 12,
        borderRadius: 12,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'rgba(220, 38, 38, 0.28)',
        background: 'var(--t-chat-surface-bg)',
        boxShadow: 'var(--t-panel-shadow), 0 10px 30px rgba(15, 23, 42, 0.22)',
      }}
    >
      <AlertTriangle size={14} strokeWidth={1.9} style={{ color: '#dc2626', flexShrink: 0 }} />
      <span style={{
        fontSize: 12,
        fontWeight: 420,
        lineHeight: 1.45,
        color: 'var(--t-text)',
        letterSpacing: '-0.005em',
        wordBreak: 'break-word',
      }}>
        {message}
      </span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 22,
          height: 22,
          borderRadius: 6,
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          color: 'var(--t-text-faint)',
          flexShrink: 0,
        }}
      >
        <X size={12} strokeWidth={1.9} />
      </button>
    </div>
  );
}
