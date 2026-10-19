'use client';

import type { CSSProperties, ReactNode } from 'react';
import { HeaderIconPill } from '@/components/desktop/shell/HeaderIconPill';
import { RamsButton } from '@/components/desktop/settings/RamsButton';
import { SendPill } from '@/components/desktop/thoughts/ComposerSendControl';
import { canUseTauriEvents } from '@/lib/tauri/bridge';
import { MAX_VISUAL_FRAMES } from '@/lib/composer/visual-instruction';
import { VisualInstructionClarification } from './VisualInstructionClarification';
import type { VisualComposerBinding } from './VisualInstructionComposer';

const meta: CSSProperties = { fontSize: 10, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.25, color: 'var(--t-text-muted)' };
const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 };
export function VisualGlyph({ kind }: { kind: 'capture' | 'image' | 'close' | 'trash' | 'clarify' }) {
  const paths: Record<typeof kind, ReactNode> = {
    capture: <><path d="M8 4H4v4m12-4h4v4M4 16v4h4m12-4v4h-4" /><path d="m8 15 2-5 4 4 2-5" /></>,
    image: <><rect x="3" y="3" width="18" height="18" rx="3" /><path d="m3 16 5-5 5 5 3-3 5 5" /><circle cx="15.5" cy="8" r="1" /></>,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    trash: <><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7m4-7v7" /></>,
    clarify: <><path d="M12 3 9.5 9.5 3 12l6.5 2.5L12 21l2.5-6.5L21 12l-6.5-2.5L12 3Z" /></>,
  };
  return <svg aria-hidden width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">{paths[kind]}</svg>;
}
function timestamp(ms: number) { const seconds = Math.floor(ms / 1000); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; }

export function VisualInstructionEntry({ value }: { value: VisualComposerBinding }) {
  return <HeaderIconPill label={value.draft?.status === 'draft' ? 'Resume visual instruction' : 'Show with images'} title="Show with images · capture, mark, and explain" expanded={value.active} disabled={!value.enabled} yNudge={0} onClick={value.open}
    icon={<span style={{ ...row, gap: 4 }}>
      <VisualGlyph kind="capture" />
      <span style={{ ...meta, fontSize: 11, color: 'inherit' }}>Show</span>
      {value.draft?.status === 'draft' && value.draft.request.frames.length ? <span style={meta}>{value.draft.request.frames.length}</span> : null}
    </span>} />;
}

export function VisualInstructionAttachments({ value }: { value: VisualComposerBinding }) {
  const frames = value.draft?.request.frames ?? [];
  return <section aria-label="Visual instruction frames" style={{ paddingTop: 8, paddingRight: 14, paddingBottom: 0, paddingLeft: 14 }}>
    <div style={{ ...row, justifyContent: 'space-between', minHeight: 26 }}>
      <div style={row}><VisualGlyph kind="capture" /><span style={{ fontSize: 12, fontWeight: 300, letterSpacing: '-0.1px' }}>Visual instruction</span><span style={meta}>{frames.length} / {MAX_VISUAL_FRAMES}</span></div>
      <div style={{ ...row, gap: 0 }}>
        <HeaderIconPill label="Discard visual draft" icon={<VisualGlyph kind="trash" />} expanded={value.confirmClear} disabled={value.busy || value.capturing} yNudge={0} onClick={value.toggleClear} />
        <HeaderIconPill label="Close visual draft" title="Close · draft stays in this chat" icon={<VisualGlyph kind="close" />} disabled={value.busy || value.capturing} yNudge={0} onClick={value.close} />
      </div>
    </div>
    {frames.length ? <div style={{ display: 'flex', gap: 8, paddingTop: 8, paddingBottom: 4, overflowX: 'auto', overscrollBehaviorX: 'contain' }}>
      {frames.map((frame, index) => <div key={frame.id} style={{ position: 'relative', width: 112, flexShrink: 0 }}>
        <button type="button" aria-label={`Annotate frame ${index + 1}`} disabled={value.locked} onClick={() => value.annotate(frame.id)} style={{ display: 'block', width: '100%', border: '1px solid var(--t-divider-subtle)', borderRadius: 8, background: 'var(--t-chat-surface-bg)', color: 'var(--t-text)', padding: 0, overflow: 'hidden', cursor: value.locked ? 'default' : 'pointer' }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- immutable, locally decoded capture */}
          <img src={frame.image.dataUri} alt={`Marked frame ${index + 1}`} style={{ display: 'block', width: 110, height: 70, objectFit: 'contain' }} />
          <span style={{ ...meta, display: 'flex', justifyContent: 'space-between', paddingTop: 5, paddingRight: 7, paddingBottom: 5, paddingLeft: 7, fontVariantNumeric: 'tabular-nums' }}><span>{String(index + 1).padStart(2, '0')}</span><span>{timestamp(frame.atMs)}</span></span>
        </button>
        <div style={{ position: 'absolute', top: 2, right: 2, borderRadius: 7, background: 'var(--t-chat-surface-input-bg, var(--t-input-bg))' }}><HeaderIconPill label={`Remove frame ${index + 1}`} icon={<VisualGlyph kind="close" />} disabled={value.locked} yNudge={0} onClick={() => value.removeFrame(frame.id)} /></div>
      </div>)}
      {frames.length < MAX_VISUAL_FRAMES ? <button type="button" aria-label="Add another image" disabled={value.locked} onClick={value.pickImages} style={{ ...meta, width: 60, flexShrink: 0, alignSelf: 'stretch', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, border: '1px dashed var(--t-divider-subtle)', borderRadius: 8, background: 'transparent', cursor: value.locked ? 'default' : 'pointer' }}><span aria-hidden style={{ fontSize: 20, fontWeight: 260, lineHeight: 1 }}>+</span><span>Add</span></button> : null}
    </div> : <p style={{ ...meta, marginTop: 8, marginBottom: 0, lineHeight: 1.5 }}>Add an image, then mark the detail you want your agent to see.</p>}
    {value.confirmClear ? <div role="group" aria-label="Confirm discard" style={{ ...row, paddingTop: 8, paddingBottom: 8, flexWrap: 'wrap' }}><span style={{ ...meta, flex: 1 }}>Discard this draft?</span><RamsButton variant="danger" disabled={value.busy || value.capturing} onClick={value.clear}>Discard</RamsButton><RamsButton variant="ghost" onClick={value.toggleClear}>Keep draft</RamsButton></div> : null}
  </section>;
}

export function VisualInstructionFooter({ value }: { value: VisualComposerBinding }) {
  const full = (value.draft?.request.frames.length ?? 0) >= MAX_VISUAL_FRAMES;
  const route = value.draft?.template.routing;
  return <div style={{ ...row, justifyContent: 'space-between', paddingTop: 4, paddingRight: 12, paddingBottom: 10, paddingLeft: 8 }}>
    <div style={{ ...row, gap: 0 }}>
      {canUseTauriEvents() ? <HeaderIconPill label="Capture screen" title="Capture and speak · ⌘⇧Y" icon={<VisualGlyph kind="capture" />} disabled={value.locked || full} yNudge={0} onClick={value.captureScreen} /> : null}
      <HeaderIconPill label="Add image" icon={<VisualGlyph kind="image" />} disabled={value.locked || full} yNudge={0} onClick={value.pickImages} />
      {value.draft ? <VisualInstructionClarification draft={value.draft} disabled={value.locked} /> : null}
    </div>
    <div style={{ ...row, gap: 12 }}>
      <span title={route ? `${route.backend} · ${route.model} · ${route.effort}` : undefined} style={{ ...meta, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 }}>{value.draft?.status === 'unknown' ? 'Check delivery' : value.busy ? 'Saving…' : value.capturing ? 'Capturing…' : 'This chat'}</span>
      <SendPill canSubmit={value.canSend} working={value.busy} onSubmit={value.send} targetLabel="Visual instruction" />
    </div>
  </div>;
}

export function VisualInstructionFeedback({ value }: { value: VisualComposerBinding }) {
  const notice = value.error ?? value.draft?.error;
  if (!notice && !value.capturing) return null;
  return <div role="status" style={{ ...row, justifyContent: 'space-between', paddingTop: 6, paddingRight: 2, paddingLeft: 2, ...meta, lineHeight: 1.5 }}>
    <span style={{ color: value.error || value.draft?.status === 'unknown' ? 'var(--t-brand-red)' : 'var(--t-text-muted)', overflowWrap: 'anywhere' }}>{value.capturing ? 'Capturing for this chat. Finish with ⌘⇧Y.' : notice}</span>
    {value.draft?.status === 'saved' ? <HeaderIconPill label="Dismiss visual receipt" icon={<VisualGlyph kind="close" />} yNudge={0} onClick={value.clear} /> : null}
  </div>;
}
