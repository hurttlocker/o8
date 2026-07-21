'use client';

import { useEffect, useRef } from 'react';
import {
  SEND_UNDO_GRACE_MS,
  type QueuedComposerSend,
} from '@/lib/hooks/use-composer-send-buffer';

interface ComposerSendBufferStatusProps {
  undoArmed: boolean;
  undoSequence: number;
  queued: QueuedComposerSend[];
  onUndo: () => void;
  onCancelQueued: (id: number) => void;
}

export function ComposerSendBufferStatus({
  undoArmed,
  undoSequence,
  queued,
  onUndo,
  onCancelQueued,
}: ComposerSendBufferStatusProps) {
  if (!undoArmed && queued.length === 0) return null;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 6,
        paddingRight: 2,
        paddingBottom: 8,
        paddingLeft: 2,
      }}
    >
      {undoArmed ? (
        <UndoSendButton key={undoSequence} onUndo={onUndo} />
      ) : null}
      {queued.length > 0 ? (
        <div
          role="list"
          aria-label={`${queued.length} queued message${queued.length === 1 ? '' : 's'}`}
          style={{ display: 'flex', flexWrap: 'wrap', gap: 5, width: '100%' }}
        >
          {queued.map((item) => (
            <div
              key={item.id}
              role="listitem"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                minWidth: 0,
                maxWidth: '100%',
                paddingTop: 5,
                paddingRight: 5,
                paddingBottom: 5,
                paddingLeft: 10,
                borderRadius: 999,
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: 'var(--t-divider)',
                background: 'var(--t-input-bg)',
                color: 'var(--t-text)',
                boxShadow: 'var(--t-panel-shadow)',
              }}
            >
              <span
                style={{
                  maxWidth: 280,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontFamily: 'var(--font-sans-system)',
                  fontSize: 11,
                }}
              >
                {item.text}
                {item.images.length > 0 ? (
                  <span style={{ color: 'var(--t-text-muted)' }}>
                    {` · ${item.images.length} image${item.images.length === 1 ? '' : 's'}`}
                  </span>
                ) : null}
              </span>
              <button
                type="button"
                aria-label={`Cancel queued message: ${item.text}`}
                title="Cancel queued message"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => onCancelQueued(item.id)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 20,
                  height: 20,
                  paddingTop: 0,
                  paddingRight: 0,
                  paddingBottom: 0,
                  paddingLeft: 0,
                  borderWidth: 0,
                  borderRadius: 999,
                  background: 'transparent',
                  color: 'var(--t-text-muted)',
                  cursor: 'pointer',
                  flexShrink: 0,
                }}
              >
                <svg width={11} height={11} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden>
                  <path d="M4 4l8 8M12 4l-8 8" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function UndoSendButton({ onUndo }: { onUndo: () => void }) {
  const progressRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const progress = progressRef.current;
    if (!progress) return;
    const animation = progress.animate(
      [{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }],
      { duration: SEND_UNDO_GRACE_MS, easing: 'linear', fill: 'forwards' },
    );
    return () => animation.cancel();
  }, []);

  return (
    <button
      type="button"
      aria-label="Undo send and restore the message"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={onUndo}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        overflow: 'hidden',
        paddingTop: 6,
        paddingRight: 11,
        paddingBottom: 6,
        paddingLeft: 10,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-divider)',
        borderRadius: 999,
        background: 'var(--t-input-bg)',
        color: 'var(--t-text)',
        boxShadow: 'var(--t-panel-shadow)',
        cursor: 'pointer',
        fontFamily: 'var(--font-sans-system)',
        fontSize: 11,
      }}
    >
      <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M9 14 4 9l5-5" />
        <path d="M4 9h11a5 5 0 0 1 0 10h-1" />
      </svg>
      Undo send
      <span
        ref={progressRef}
        aria-hidden
        style={{
          position: 'absolute',
          right: 0,
          bottom: 0,
          left: 0,
          height: 2,
          background: 'var(--t-accent)',
          opacity: 0.55,
          transformOrigin: 'left center',
        }}
      />
    </button>
  );
}
