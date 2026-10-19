'use client';

import type { CSSProperties } from 'react';

export interface VisualCaptureBounds { left: number; top: number; right: number; bottom: number }
export type VisualCaptureVoice = 'starting' | 'recording' | 'transcribing' | 'complete' | 'unavailable';

/** Keep the instruction next to its mark, including at a monitor's edges. */
export function visualCaptureInputPosition(bounds: VisualCaptureBounds, viewport: { width: number; height: number }) {
  const width = Math.max(0, Math.min(360, viewport.width - 24));
  const height = 100;
  const below = bounds.bottom + 12;
  return { width, left: Math.max(12, Math.min((bounds.left + bounds.right - width) / 2, viewport.width - width - 12)),
    top: Math.max(12, Math.min(below + height <= viewport.height - 12 ? below : bounds.top - height - 12, viewport.height - height - 12)) };
}

const iconButton: CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  width: 28, height: 28, padding: 0, border: 0, borderRadius: 8, background: 'transparent', color: 'var(--t-text-muted)', cursor: 'pointer' };

export function VisualCaptureInput(props: {
  bounds: VisualCaptureBounds; viewport: { width: number; height: number }; value: string;
  voice: VisualCaptureVoice; busy: boolean; voiceText?: string; onChange: (value: string) => void;
  onFinish: () => void; onCancel: () => void;
}) {
  const position = visualCaptureInputPosition(props.bounds, props.viewport);
  const voiceLabel = props.voice === 'recording' ? 'Microphone recording' : props.voice === 'starting' ? 'Starting microphone' : props.voice === 'transcribing' ? 'Transcribing' : props.voice === 'complete' ? 'Voice added' : 'Microphone unavailable';
  return <div data-visual-capture-controls="true" role="group" aria-label="Instruction for marked area" style={{ position: 'fixed', ...position,
    boxSizing: 'border-box', paddingTop: 10, paddingRight: 10, paddingBottom: 6, paddingLeft: 14, borderRadius: 16,
    background: 'color-mix(in srgb, var(--t-popover-bg, #242424) 82%, transparent)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
    border: '1px solid var(--t-divider-subtle)', boxShadow: '0 8px 28px rgba(0,0,0,0.18)', color: 'var(--t-text)',
    fontFamily: 'var(--font-sans-system)', cursor: 'default' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <textarea aria-label="Visual instruction" placeholder="What should change?" value={props.value} maxLength={16_000} disabled={props.busy}
        onChange={event => props.onChange(event.target.value)} onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (!props.busy) props.onFinish(); }
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); props.onCancel(); }
        }} rows={2} style={{ flex: 1, minWidth: 0, height: 42, resize: 'none', boxSizing: 'border-box', padding: 0, border: 0,
          outline: 'none', background: 'transparent', color: 'var(--t-text)', fontFamily: 'inherit', fontSize: 13, fontWeight: 300, lineHeight: '21px' }} />
      <button type="button" aria-label="Add to chat" title="Add picture and instruction to this chat · Enter" disabled={props.busy} onClick={props.onFinish}
        style={{ ...iconButton, width: 32, height: 32, background: 'var(--t-accent)', color: 'var(--t-accent-contrast)', opacity: props.busy ? 0.5 : 1 }}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4" /></svg>
      </button>
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
      <span role="img" aria-label={voiceLabel} title={voiceLabel}
        style={{ ...iconButton, width: 24, height: 24, cursor: 'default', color: props.voice === 'recording' ? 'var(--t-brand-orange)' : 'var(--t-text-muted)' }}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true"><rect x="5.5" y="1.5" width="5" height="8" rx="2.5" /><path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5M5.5 14.5h5" /></svg>
      </span>
      <span role="status" title={props.voiceText} style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10, fontWeight: 300, color: 'var(--t-text-muted)' }}>
        {props.busy ? 'Adding to chat…' : props.voiceText || (props.voice === 'recording' ? 'Listening · Enter to add to chat' : props.voice === 'transcribing' ? 'Transcribing · Enter to add to chat' : 'This chat · Enter to add')}
      </span>
      <button type="button" aria-label="Cancel capture" title="Cancel · Esc" disabled={props.busy} onClick={props.onCancel} style={{ ...iconButton, width: 24, height: 24 }}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
      </button>
    </div>
  </div>;
}
