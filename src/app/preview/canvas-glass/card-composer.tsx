'use client';

/**
 * Card composer — the canvas bottom-composer at card scale, shared by the
 * pinned dock and the floating chat-cards (and any modal that grows the same
 * conversation surface). Borderless soft-tint pill. Two of Q's design tips,
 * ported from the agent-card bench:
 *  - the textarea GROWS with content (`field-sizing: content`) instead of
 *    nested-scrolling — capped at ~5 rows, then it scrolls;
 *  - Input Anticipation — the focus ring fades in as the pointer nears the
 *    composer, so the card reaches back before you click. Driven by direct
 *    style mutation off the render path.
 */

import { useCallback, useEffect, useRef } from 'react';
import { FONT } from './ui';
import { useDictationHostOptional } from '@/components/desktop/dictation/DictationHost';
import { MicButton } from '@/components/desktop/thoughts/MicButton';

export function CardComposer({
  value,
  onChange,
  onSubmit,
  busy = false,
  placeholder,
  model,
  anticipate = false,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  busy?: boolean;
  placeholder: string;
  /** Model label shown as a quiet chip before the send button (bench parity). */
  model?: string;
  /** Input Anticipation focus ring — fades in as the pointer nears. OFF by
   *  default and opt-in only for ANCHORED composers (the pinned dock, the
   *  bottom o8 composer). A floating canvas chat-card sits INSIDE the CSS-zoom
   *  layer, where the ring's rect (zoom-scaled) vs the global pointer coords
   *  make it mis-anchor + light up from across the canvas — so the small chats
   *  leave it off (operator call 2026-06-14). */
  anticipate?: boolean;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const ringRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Latest value + onChange kept in refs so the dictation fill closure
  // (registered once on focus, invoked async when speech lands) appends to the
  // current draft instead of a stale snapshot.
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    valueRef.current = value;
    onChangeRef.current = onChange;
  }, [onChange, value]);

  // Register this composer as the dictation target on focus — speech is
  // transcribed by the shared DictationHost and routed back through `fill`,
  // appended to whatever is already typed. Same engine the default IDE
  // composer uses; null host (no provider) is a no-op (mic hides itself).
  const host = useDictationHostOptional();
  const registerForDictation = useCallback(() => {
    const node = textareaRef.current;
    if (!node || !host) return;
    host.setActiveComposer({
      node,
      fill: (text: string) => {
        const current = valueRef.current.trim();
        onChangeRef.current(current ? `${current} ${text}` : text);
      },
    });
  }, [host]);

  useEffect(() => {
    if (!anticipate) return;
    const onMove = (event: PointerEvent) => {
      const box = boxRef.current;
      const ring = ringRef.current;
      if (!box || !ring) return;
      const r = box.getBoundingClientRect();
      const dx = Math.max(r.left - event.clientX, 0, event.clientX - r.right);
      const dy = Math.max(r.top - event.clientY, 0, event.clientY - r.bottom);
      const intent = Math.max(0, 1 - Math.hypot(dx, dy) / 180) ** 2;
      ring.style.opacity = String(intent);
    };
    window.addEventListener('pointermove', onMove);
    return () => window.removeEventListener('pointermove', onMove);
  }, [anticipate]);

  const inputStyle: React.CSSProperties & { fieldSizing?: 'content' } = {
    flex: 1,
    borderWidth: 0,
    outline: 'none',
    resize: 'none',
    background: 'transparent',
    color: 'var(--cnv-ink)',
    fontSize: 12.5,
    fontWeight: 300,
    letterSpacing: '-0.1px',
    fontFamily: FONT,
    lineHeight: 1.45,
    maxHeight: 104,
    overflowY: 'auto',
    fieldSizing: 'content',
    opacity: busy ? 0.55 : 1,
  };

  return (
    <div
      ref={boxRef}
      style={{ position: 'relative', display: 'flex', alignItems: 'flex-end', gap: 8, paddingTop: 7, paddingBottom: 7, paddingLeft: 13, paddingRight: 9, borderRadius: 18, background: 'var(--cnv-tint)' }}
    >
      {/* Input Anticipation focus ring — opacity driven by pointer proximity.
          Anchored composers only (see `anticipate`); off for floating chats. */}
      {anticipate ? (
        <div
          ref={ringRef}
          aria-hidden
          style={{ position: 'absolute', inset: 0, borderRadius: 18, pointerEvents: 'none', opacity: 0, boxShadow: 'inset 0 0 0 1.5px var(--cnv-ink), 0 0 16px -4px var(--cnv-ink)' }}
        />
      ) : null}
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onFocus={registerForDictation}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            onSubmit();
          }
        }}
        rows={1}
        placeholder={placeholder}
        aria-label={placeholder}
        spellCheck={false}
        disabled={busy}
        style={inputStyle}
      />
      {/* Model chip + send ride as one center-aligned group so the label sits
          on the arrow's vertical center (not bottom-baselined low). The group
          stays a flex-end child of the row, so it pins to the bottom as the
          textarea grows multi-line. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        {model ? (
          <span style={{ fontSize: 10.5, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--cnv-ink-muted)', whiteSpace: 'nowrap' }}>
            {model}
          </span>
        ) : null}
        {/* Push-to-talk — speak instead of type. Canvas-tinted idle color so it
            sits flush with the send arrow. Hidden when no dictation host. */}
        <MicButton idleColor="var(--cnv-ink-muted)" />
        <button
          type="button"
          aria-label="Send"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onSubmit}
          disabled={busy}
          style={{ borderWidth: 0, background: 'transparent', padding: 3, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: busy ? 'default' : 'pointer', color: 'var(--cnv-ink-muted)', flexShrink: 0, opacity: busy ? 0.4 : 1 }}
          onMouseEnter={(event) => { if (!busy) event.currentTarget.style.color = 'var(--cnv-ink)'; }}
          onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
        >
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="m22 2-7 20-4-9-9-4z" /><path d="M22 2 11 13" />
          </svg>
        </button>
      </div>
    </div>
  );
}
