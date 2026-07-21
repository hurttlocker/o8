'use client';

/**
 * useSendBuffer — the "humans make mistakes" layer for every canvas composer.
 *
 * Two behaviors, shared by the bottom composer, the dock, and each floating
 * chat card (every place you can talk to an orchestrator):
 *
 *  1. UNDO-SEND GRACE BUFFER. After a message goes out there's a short window
 *     where Stop both halts the run AND snaps the text + images back into the
 *     composer — transcript trace erased — as if you never sent it. Catch it
 *     past the window and Stop just stops (the send stands).
 *
 *  2. QUEUE WHEN BUSY. Send while the orchestrator is mid-turn and the message
 *     is queued (the default o8 composer's behavior) instead of dropped; it
 *     fires when the current turn settles.
 *
 * The hook is conversation-agnostic — the host wires in how to actually
 * dispatch / interrupt / restore-to-composer / erase-the-transcript, since
 * those differ per surface (the convo entries live in page state, the composer
 * value lives in the composer).
 */

import { motion } from 'framer-motion';
import {
  SEND_UNDO_GRACE_MS,
  useComposerSendBuffer,
  type ComposerSendBuffer,
  type ComposerSendImage,
  type QueuedComposerSend,
} from '@/lib/hooks/use-composer-send-buffer';
import { FONT } from './ui';

export { SEND_UNDO_GRACE_MS };
export type ComposerImage = ComposerSendImage;
export type QueuedSend = QueuedComposerSend;

/** Where an undo would truncate the transcript back to. Returned by a
 *  successful dispatch; null means the send never went out (don't arm undo). */
export interface DispatchHandle { lane: string; fromEntryId: number }

export interface SendBufferConfig {
  /** The conversation is mid-turn. */
  busy: boolean;
  graceMs?: number;
  /** Actually send + append the user entry. Return the truncation handle, or
   *  null if it didn't go out (e.g. socket not ready). */
  dispatch: (text: string, images: ComposerImage[]) => DispatchHandle | null;
  /** Halt the running turn. */
  interrupt: () => void;
  /** Put the message back where it came from. */
  restore: (text: string, images: ComposerImage[]) => void;
  /** Erase an undone send's transcript trace (everything at/after the handle). */
  truncate: (lane: string, fromEntryId: number) => void;
}

export type SendBuffer = ComposerSendBuffer;

export function useSendBuffer(config: SendBufferConfig): SendBuffer {
  return useComposerSendBuffer({
    busy: config.busy,
    graceMs: config.graceMs,
    dispatch: config.dispatch,
    interrupt: config.interrupt,
    restore: config.restore,
    truncate: (handle) => config.truncate(handle.lane, handle.fromEntryId),
  });
}

/** The take-it-back affordance — a quiet pill that surfaces for the grace
 *  window with a depleting underline (catch it quick). Tap = stop + restore. */
export function UndoSendPill({ onUndo, graceMs = SEND_UNDO_GRACE_MS }: { onUndo: () => void; graceMs?: number }) {
  return (
    <motion.button
      type="button"
      initial={{ opacity: 0, y: 6, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 6, scale: 0.96 }}
      transition={{ type: 'spring', stiffness: 420, damping: 30 }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={onUndo}
      aria-label="Undo send — stop and bring the message back"
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        paddingTop: 5,
        paddingBottom: 5,
        paddingLeft: 11,
        paddingRight: 12,
        borderWidth: 0,
        borderRadius: 999,
        background: 'var(--cnv-tint-deep)',
        backdropFilter: 'blur(calc(var(--cnv-frost) * 0.6)) saturate(var(--cnv-sat, 1.6))',
        WebkitBackdropFilter: 'blur(calc(var(--cnv-frost) * 0.6)) saturate(var(--cnv-sat, 1.6))',
        color: 'var(--cnv-ink)',
        cursor: 'pointer',
        fontFamily: FONT,
        fontSize: 11,
        fontWeight: 400,
        letterSpacing: '-0.1px',
        boxShadow: '0 8px 24px rgba(0,0,0,0.22)',
        overflow: 'hidden',
      }}
    >
      <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ display: 'block', width: 12, height: 12, flexShrink: 0 }}>
        <path d="M9 14 4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-1" />
      </svg>
      Undo send
      {/* Depleting underline — the window closing. */}
      <motion.span
        aria-hidden
        initial={{ scaleX: 1 }}
        animate={{ scaleX: 0 }}
        transition={{ duration: graceMs / 1000, ease: 'linear' }}
        style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 1.5, background: 'var(--cnv-ink-muted)', transformOrigin: 'left center', opacity: 0.6 }}
      />
    </motion.button>
  );
}

/** Messages waiting their turn — small pills with a remove ✕, above the
 *  composer. The default o8 composer's queue, canvas-side. */
export function QueuedSends({ items, onCancel }: { items: QueuedSend[]; onCancel: (id: number) => void }) {
  if (items.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingBottom: 6 }}>
      <span style={{ fontSize: 8.5, fontWeight: 300, letterSpacing: '0.11em', textTransform: 'uppercase', color: 'var(--cnv-ink-muted)', fontFamily: FONT, paddingLeft: 4 }}>
        Queued · {items.length}
      </span>
      {items.map((item) => (
        <div
          key={item.id}
          style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 5, paddingBottom: 5, paddingLeft: 11, paddingRight: 7, borderRadius: 12, background: 'var(--cnv-tint)' }}
        >
          <span aria-hidden style={{ width: 4, height: 4, borderRadius: '50%', background: 'var(--cnv-ink-muted)', flexShrink: 0 }} />
          <span style={{ flex: 1, minWidth: 0, fontSize: 11, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--cnv-ink)', fontFamily: FONT, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {item.text}
            {item.images.length ? <span style={{ color: 'var(--cnv-ink-muted)' }}>{`  · ${item.images.length} image${item.images.length === 1 ? '' : 's'}`}</span> : null}
          </span>
          <button
            type="button"
            aria-label="Remove from queue"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onCancel(item.id)}
            style={{ borderWidth: 0, background: 'transparent', padding: 2, fontSize: 10, lineHeight: 1, color: 'var(--cnv-ink-muted)', cursor: 'pointer', fontFamily: FONT, flexShrink: 0 }}
            onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
            onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
