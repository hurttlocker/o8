'use client';

import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { VisualInstructionClarification } from './VisualInstructionClarification';
import { useO8Auth } from '@/components/auth/O8AuthProvider';
import { RamsButton } from '@/components/desktop/settings/RamsButton';
import { ScreenshotAnnotator } from '@/components/desktop/thoughts/chat-panel/ScreenshotAnnotator';
import { canUseTauriEvents } from '@/lib/tauri/bridge';
import { ownsVisualDraft, subscribeVisualCapture } from '@/lib/composer/visual-capture-state';
import { visualCaptureTargets, type VisualCaptureTarget } from '@/lib/composer/visual-capture-targets';
import { readVisualDraft, removeVisualDraft, restoreVisualDraft, saveVisualDraft, subscribeVisualDrafts, type VisualInstructionDraft } from '@/lib/composer/visual-draft-store';
import { MAX_VISUAL_FRAMES, visualInstructionScope, type VisualInstructionTarget } from '@/lib/composer/visual-instruction';
import { VisualInstructionDeliveryError, submitVisualInstruction, VISUAL_REQUEST_MARKER } from '@/lib/composer/visual-instruction-send';
import type { ComposerQueuePayload } from '@/lib/orchestrator/composer-queue-types';
import type { ComposerSendImage } from '@/lib/hooks/use-composer-send-buffer';

interface Props {
  active: boolean; target: VisualInstructionTarget | null; label: string;
  anchor: RefObject<HTMLTextAreaElement | null>;
  capture: (text: string, images: ComposerSendImage[]) => ComposerQueuePayload;
}
const noDraft = () => null;
const inputStyle = { width: '100%', boxSizing: 'border-box' as const, background: 'var(--t-input-bg)', color: 'var(--t-text)',
  border: '1px solid var(--t-border)', borderRadius: 8, padding: 8, font: 'inherit', fontSize: 13, fontWeight: 300 };

export function VisualInstructionComposer(props: Props) {
  const auth = useO8Auth();
  const principal = auth.user?.id ?? 'local';
  const current = useRef({ props, principal, loaded: auth.isLoaded }); current.current = { props, principal, loaded: auth.isLoaded };
  const registration = useRef<VisualCaptureTarget | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const scope = props.target ? visualInstructionScope(props.target) : '';
  const capturing = useSyncExternalStore(subscribeVisualCapture, () => props.target ? ownsVisualDraft(principal, props.target) : false, () => false);
  const draft = useSyncExternalStore(subscribeVisualDrafts,
    () => props.target ? readVisualDraft(principal, props.target) : null, noDraft);
  useEffect(() => {
    if (current.current.props.target && auth.isLoaded) void restoreVisualDraft(principal, current.current.props.target).catch(cause => setError(String(cause)));
  }, [auth.isLoaded, principal, scope]);
  useEffect(() => {
    const { props: selectedProps } = current.current;
    if (!selectedProps.active || !selectedProps.target || !auth.isLoaded) return;
    const target = { ...selectedProps.target };
    const selected: VisualCaptureTarget = { principal, target, label: selectedProps.label,
      eligible: () => current.current.principal === principal && current.current.props.active
        && current.current.props.target !== null && visualInstructionScope(current.current.props.target) === scope
        && Boolean(props.anchor.current?.isConnected && props.anchor.current.getClientRects().length),
      template: () => current.current.props.capture(VISUAL_REQUEST_MARKER, []),
    };
    registration.current = selected;
    const unregister = visualCaptureTargets.register(selected);
    const focus = () => visualCaptureTargets.focus(selected);
    const textarea = props.anchor.current;
    textarea?.addEventListener('focus', focus); textarea?.addEventListener('pointerdown', focus);
    return () => { unregister(); textarea?.removeEventListener('focus', focus); textarea?.removeEventListener('pointerdown', focus); registration.current = null; };
  }, [auth.isLoaded, principal, props.active, props.anchor, props.label, scope]);

  const save = (value: VisualInstructionDraft) => { void saveVisualDraft(value).catch(cause => setError(String(cause))); };
  const captureScreen = () => { if (registration.current) visualCaptureTargets.request(registration.current); setExpanded(true); };
  const addFiles = async (files: File[]) => {
    if (!props.target || busy || capturing || draft?.status === 'saving' || draft?.status === 'unknown' || draft?.status === 'saved') return;
    const target = { ...props.target };
    const snapshot: VisualInstructionDraft = draft ?? { principal, status: 'draft', template: props.capture(VISUAL_REQUEST_MARKER, []),
      request: { version: 1, id: crypto.randomUUID(), createdAt: new Date().toISOString(), target, utterance: '', frames: [] } };
    if (files.length + snapshot.request.frames.length > MAX_VISUAL_FRAMES) { setError('Use at most four frames in one visual instruction.'); return; }
    setBusy(true); setError(null); setExpanded(true);
    try {
      const frames = [];
      for (const file of files) {
        if (!/^image\/(?:png|jpeg|gif|webp)$/.test(file.type) || file.size > 3_700_000) throw new Error('Use PNG, JPEG, GIF or WebP images under 3.7 MB.');
        const dataUri = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file); });
        const image = new window.Image(); image.src = dataUri; await image.decode();
        frames.push({ id: `frame-${crypto.randomUUID()}`, atMs: Math.min(3_600_000, Math.max(0, Date.now() - Date.parse(snapshot.request.createdAt))),
          width: image.naturalWidth, height: image.naturalHeight, transcript: '', image: { name: file.name, dataUri }, strokes: [], pins: [] });
      }
      await saveVisualDraft({ ...snapshot, request: { ...snapshot.request, clarification: undefined, frames: [...snapshot.request.frames, ...frames] } });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const send = async () => {
    if (!draft || busy || capturing || !draft.request.utterance.trim() || !draft.request.frames.length) return;
    setBusy(true); setError(null);
    try {
      await saveVisualDraft({ ...draft, status: 'saving', error: undefined });
      if (!current.current.loaded || current.current.principal !== draft.principal) throw new VisualInstructionDeliveryError('The account changed before dispatch. The original draft is retained.');
      const item = await submitVisualInstruction(draft);
      await saveVisualDraft({ ...draft, status: 'saved', error: item.status === 'queued' ? 'Queued in the selected chat. Agent completion is not yet confirmed.' : 'Saved in the selected chat. Check its result there.' });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      await saveVisualDraft({ ...draft, status: cause instanceof VisualInstructionDeliveryError && !cause.uncertain ? 'draft' : 'unknown', error: message }).catch(() => {});
      setError(message);
    } finally { setBusy(false); }
  };
  const locked = busy || capturing || (draft !== null && draft.status !== 'draft');
  const editFrame = draft?.request.frames.find(frame => frame.id === editing);
  if (!props.active) return null;
  return <div style={{ marginBottom: 8, color: 'var(--t-text)', fontWeight: 300 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <RamsButton variant="ghost" disabled={!props.target || !auth.isLoaded} aria-expanded={expanded || Boolean(draft)} aria-controls={`visual-${props.target?.threadId ?? 'new'}`} onClick={() => { setExpanded(value => !value); if (registration.current) visualCaptureTargets.focus(registration.current); }}>
        Show{draft ? ` · ${draft.request.frames.length}` : ''}
      </RamsButton>
      {expanded || draft ? <span style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>To {props.label}</span> : null}
    </div>
    {expanded || draft ? <div id={`visual-${props.target?.threadId ?? 'new'}`} style={{ marginTop: 8, padding: 12, borderRadius: 12, background: 'var(--t-bg-card)' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {canUseTauriEvents() ? <RamsButton variant="ghost" onClick={captureScreen} disabled={locked || (draft?.request.frames.length ?? 0) >= MAX_VISUAL_FRAMES}>Capture screen · ⌘⇧Y</RamsButton> : null}
        <RamsButton variant="ghost" onClick={() => input.current?.click()} disabled={locked || !props.target || (draft?.request.frames.length ?? 0) >= MAX_VISUAL_FRAMES} busy={busy}>Add image</RamsButton>
        <input ref={input} aria-label="Add visual instruction frames" type="file" multiple accept="image/png,image/jpeg,image/gif,image/webp" style={{ display: 'none' }} onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void addFiles(files); }} />
      </div>
      {capturing ? <p role="status" style={{ fontSize: 12 }}>Capture is active for this chat. Finish or cancel it before sending.</p> : null}
      {draft ? <>
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          {draft.request.frames.map((frame, index) => <div key={frame.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><button type="button" aria-label={`Annotate frame ${index + 1}`} disabled={locked} onClick={() => setEditing(frame.id)} style={{ background: 'transparent', color: 'var(--t-text-muted)', border: '1px solid var(--t-border)', borderRadius: 8, padding: 4, cursor: 'pointer' }}>
            {/* eslint-disable-next-line @next/next/no-img-element -- local, already decoded capture data */}
            <img src={frame.image.dataUri} alt={`Marked frame ${index + 1}`} style={{ width: 100, height: 64, objectFit: 'contain', display: 'block' }} />
            <span style={{ fontSize: 10 }}>{index + 1} · {(frame.atMs / 1_000).toFixed(1)}s</span>
          </button><RamsButton variant="ghost" disabled={locked} aria-label={`Remove frame ${index + 1}`} onClick={() => save({ ...draft, request: { ...draft.request, clarification: undefined, frames: draft.request.frames.filter(item => item.id !== frame.id) } })}>Remove</RamsButton></div>)}
        </div>
        <textarea aria-label="Visual instruction" value={draft.request.utterance} disabled={locked} placeholder="Explain what the marked frames mean…" rows={3} maxLength={16_000} style={{ ...inputStyle, marginTop: 12, resize: 'vertical' }} onChange={event => save({ ...draft, request: { ...draft.request, utterance: event.target.value, clarification: undefined } })} />
        <VisualInstructionClarification draft={draft} disabled={locked} />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
          {draft.status !== 'saved' ? <RamsButton onClick={() => { void send(); }} busy={busy} disabled={capturing || !draft.request.utterance.trim() || !draft.request.frames.length}>{draft.status === 'unknown' ? 'Check delivery' : 'Send to chat'}</RamsButton> : null}
          <RamsButton variant="ghost" disabled={busy || capturing} aria-expanded={confirmClear} onClick={() => setConfirmClear(value => !value)}>{draft.status === 'draft' ? 'Clear capture' : 'Close capture'}</RamsButton>
          {confirmClear ? <RamsButton variant="danger" disabled={busy || capturing} onClick={() => { void removeVisualDraft(principal, draft.request.target, draft.request.id).then(() => { setConfirmClear(false); setExpanded(false); }).catch(cause => setError(String(cause))); }}>{draft.status === 'draft' ? 'Confirm clear' : 'Close local copy'}</RamsButton> : null}
        </div>
      </> : <p style={{ marginBottom: 0, fontSize: 12, color: 'var(--t-text-muted)' }}>Capture and mark up to four frames. They stay with this chat until you send.</p>}
      {error || draft?.error ? <p role="status" style={{ marginBottom: 0, fontSize: 12, color: 'var(--t-text-secondary)' }}>{error ?? draft?.error}</p> : null}
    </div> : null}
    {draft && editFrame ? <ScreenshotAnnotator image={{ ...editFrame.image, mimeType: 'image/png' }} onCancel={() => setEditing(null)} onDone={dataUri => {
      save({ ...draft, request: { ...draft.request, clarification: undefined, frames: draft.request.frames.map(frame => frame.id === editFrame.id ? { ...frame, id: `frame-${crypto.randomUUID()}`, image: { name: frame.image.name, dataUri }, strokes: [], pins: [] } : frame) } });
      setEditing(null);
    }} /> : null}
  </div>;
}
