'use client';

import { useEffect, useRef, useState } from 'react';
import { useO8Auth } from '@/components/auth/O8AuthProvider';
import { useDictation } from '@/components/desktop/dictation/useDictation';
import { canUseTauriEvents } from '@/lib/tauri/bridge';
import { subscribeTauriEvent } from '@/lib/tauri/events';
import { claimVisualCapture, releaseVisualCapture } from '@/lib/composer/visual-capture-state';
import { visualCaptureTargets, type VisualCaptureTarget } from '@/lib/composer/visual-capture-targets';
import { readVisualDraft, restoreVisualDraft, saveVisualDraft, type VisualInstructionDraft } from '@/lib/composer/visual-draft-store';
import { MAX_VISUAL_FRAMES, type VisualInstructionFrame } from '@/lib/composer/visual-instruction';
import { useDictationHostOptional } from '@/components/desktop/dictation/DictationHost';

interface Capture {
  id: string; draft: VisualInstructionDraft; atMs: number; startedAt: number; label: string;
  recordingStarted: boolean; voiceError?: string; started: Promise<void>; ready: () => void; finishing: boolean; cancelled: boolean; transcript: Promise<string>; resolve: (text: string) => void;
}
interface CapturedImage { dataUri: string; width: number; height: number; strokes: VisualInstructionFrame['strokes'] }
async function invoke<T>(command: string, id: string): Promise<T> {
  return (await import('@tauri-apps/api/core')).invoke<T>(command, { id });
}

/** One recorder survives chat view changes; it can only publish into its captured draft identity. */
export function VisualInstructionHost() {
  const auth = useO8Auth();
  const principal = auth.user?.id ?? 'local';
  const owner = useRef<Capture | null>(null);
  const voice = useDictation();
  const dictation = useDictationHostOptional();
  const dictationRef = useRef(dictation); dictationRef.current = dictation;
  const voiceRef = useRef(voice); voiceRef.current = voice;
  const [status, setStatus] = useState<{ label: string; text: string; error?: string } | null>(null);
  const finishRef = useRef<() => Promise<void>>(async () => {});
  const cancelRef = useRef<() => void>(() => {});
  const accountRef = useRef({ principal, loaded: auth.isLoaded }); accountRef.current = { principal, loaded: auth.isLoaded };

  cancelRef.current = () => {
    const capture = owner.current;
    if (!capture) return;
    capture.cancelled = true; capture.resolve(''); owner.current = null; releaseVisualCapture(capture.id);
    voiceRef.current.cancel();
    void invoke('o8_visual_capture_cancel', capture.id).catch(() => {});
    setStatus(null);
  };
  finishRef.current = async () => {
    const capture = owner.current;
    if (!capture || capture.finishing) return;
    capture.finishing = true;
    setStatus({ label: capture.label, text: 'Saving marked frame…' });
    try {
      await capture.started;
      if (capture.cancelled) return;
      const image = await invoke<CapturedImage>('o8_visual_capture_finish', capture.id);
      if (capture.cancelled || owner.current !== capture) return;
      if (capture.recordingStarted) void voiceRef.current.stopAndSubmit();
      else { voiceRef.current.cancel(); capture.resolve(''); }
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      const transcript = await Promise.race([capture.transcript, new Promise<string>(resolve => { timer = setTimeout(() => { timedOut = true; if (owner.current === capture) voiceRef.current.cancel(); resolve(''); }, 30_000); })]);
      clearTimeout(timer);
      if (capture.cancelled || accountRef.current.principal !== capture.draft.principal) return;
      const frame: VisualInstructionFrame = { id: capture.id, atMs: capture.atMs, transcript,
        image: { name: `marked-frame-${capture.draft.request.frames.length + 1}.png`, dataUri: image.dataUri },
        width: image.width, height: image.height, strokes: image.strokes, pins: [] };
      const current = readVisualDraft(capture.draft.principal, capture.draft.request.target);
      if (current && (current.request.id !== capture.draft.request.id || current.status !== 'draft')) throw new Error('The visual draft changed before this frame was saved. Capture it again.');
      const draft = current ?? capture.draft;
      const updated = { ...draft, error: undefined, request: { ...draft.request,
        utterance: [draft.request.utterance, transcript].filter(Boolean).join('\n'), frames: [...draft.request.frames, frame] } };
      await saveVisualDraft(updated);
      if (capture.cancelled || accountRef.current.principal !== capture.draft.principal) return;
      setStatus({ label: capture.label, text: 'Marked frame saved to its conversation.', ...(timedOut ? { error: 'Transcription timed out. Add your instruction in the chat before sending.' } : {}) });
    } catch (error) {
      capture.resolve(''); if (owner.current === capture) voiceRef.current.cancel();
      if (!capture.cancelled) setStatus({ label: capture.label, text: 'The frame was not added.', error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (owner.current === capture) owner.current = null;
      releaseVisualCapture(capture.id);
      if (!capture.cancelled) void invoke('o8_visual_capture_cancel', capture.id).catch(() => {});
    }
  };

  useEffect(() => visualCaptureTargets.subscribe((target: VisualCaptureTarget) => {
    if (owner.current) { void finishRef.current(); return; }
    if (!canUseTauriEvents() || !accountRef.current.loaded || target.principal !== accountRef.current.principal) return;
    void (async () => {
      if (dictationRef.current?.active) { setStatus({ label: target.label, text: 'Finish the current dictation before capturing a visual instruction.' }); return; }
      const template = target.template();
      await restoreVisualDraft(target.principal, target.target);
      if (owner.current || !accountRef.current.loaded || target.principal !== accountRef.current.principal) return;
      const prior = readVisualDraft(target.principal, target.target);
      if (prior && prior.status !== 'draft') { setStatus({ label: target.label, text: 'Close the submitted visual request before recording another.' }); return; }
      const draft: VisualInstructionDraft = prior ?? { principal: target.principal, status: 'draft',
        template, request: { version: 1, id: crypto.randomUUID(), createdAt: new Date().toISOString(),
          target: { ...target.target }, utterance: '', frames: [] } };
      if (draft.request.frames.length >= MAX_VISUAL_FRAMES) { setStatus({ label: target.label, text: 'This instruction already has four frames. Send or remove a frame first.' }); return; }
      let resolve!: (text: string) => void;
      const transcript = new Promise<string>(done => { resolve = done; });
      let ready!: () => void;
      const started = new Promise<void>(done => { ready = done; });
      const capture: Capture = { id: `frame-${crypto.randomUUID()}`, draft, label: target.label,
        atMs: Math.min(3_600_000, Math.max(0, Date.now() - Date.parse(draft.request.createdAt))), startedAt: Date.now(), recordingStarted: false, started, ready, finishing: false, cancelled: false, transcript, resolve };
      claimVisualCapture(capture.id, draft.principal, draft.request.target, draft.request.id);
      owner.current = capture;
      setStatus({ label: target.label, text: 'Capturing screen…' });
      try {
        await invoke('o8_visual_capture_begin', capture.id);
        if (capture.cancelled || owner.current !== capture || !accountRef.current.loaded || accountRef.current.principal !== target.principal) { void invoke('o8_visual_capture_cancel', capture.id).catch(() => {}); return; }
        capture.ready();
        setStatus({ label: target.label, text: 'Drawing is ready. Starting microphone…' });
        await voiceRef.current.start({ surface: 'orchestrator', preserveTranscript: true,
          context: { activeRepoPath: target.target.repoPath }, onComplete: resolve,
          onAbort: reason => { capture.voiceError = reason ?? 'Microphone cancelled.'; resolve(''); if (reason && !capture.finishing && owner.current === capture) setStatus({ label: target.label, text: 'Drawing is active. Add your instruction after capture.', error: reason }); } });
        capture.recordingStarted = true;
        if ((capture.cancelled || capture.finishing) && owner.current === capture) voiceRef.current.cancel();
        if (!capture.cancelled && !capture.finishing && owner.current === capture) {
          if (!capture.voiceError) setStatus({ label: target.label, text: 'Draw and speak. Finish capture with ⌘⇧Y.' });
          void import('@tauri-apps/api/event').then(({ emitTo }) => emitTo('spatial-ink', 'o8:visual-capture-voice', { id: capture.id, recording: !capture.voiceError })).catch(() => {});
        }
      } catch (error) {
        capture.cancelled = true; capture.resolve('');
        if (owner.current === capture) { voiceRef.current.cancel(); owner.current = null; }
        releaseVisualCapture(capture.id);
        void invoke('o8_visual_capture_cancel', capture.id).catch(() => {});
        if (!owner.current) setStatus({ label: target.label, text: 'Capture could not start.', error: error instanceof Error ? error.message : String(error) });
      } finally { capture.ready(); }
    })().catch(error => setStatus({ label: target.label, text: 'Capture could not start.', error: error instanceof Error ? error.message : String(error) }));
  }), []);

  useEffect(() => {
    if (!canUseTauriEvents()) return;
    const toggle = subscribeTauriEvent('o8:visual-capture-toggle', () => {
      if (owner.current) void finishRef.current();
      else if (!visualCaptureTargets.request()) setStatus({ label: '', text: 'Open and focus an existing chat before capturing a visual instruction.' });
    });
    const action = subscribeTauriEvent<{ id: string; action: string }>('o8:visual-capture-action', ({ payload }) => {
      if (payload.id !== owner.current?.id) return;
      if (payload.action === 'finish') void finishRef.current(); else if (payload.action === 'cancel') cancelRef.current();
    });
    const superseded = subscribeTauriEvent<{ id: string }>('o8:visual-capture-superseded', ({ payload }) => { if (payload.id === owner.current?.id) { const label = owner.current.label; cancelRef.current(); setStatus({ label, text: 'Another dictation took over. The earlier draft is retained; capture this frame again.' }); } });
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && owner.current) { event.preventDefault(); cancelRef.current(); } };
    window.addEventListener('keydown', escape);
    const safety = setInterval(() => { const capture = owner.current; if (capture && !capture.finishing && Date.now() - capture.startedAt > 80_000) void finishRef.current(); }, 1_000);
    return () => { toggle(); action(); superseded(); window.removeEventListener('keydown', escape); clearInterval(safety); cancelRef.current(); };
  }, []);
  useEffect(() => { if (!auth.isLoaded || owner.current?.draft.principal !== principal) cancelRef.current(); }, [principal, auth.isLoaded]);
  if (!status) return null;
  return <div role="status" style={{ position: 'fixed', right: 20, bottom: 50, zIndex: 1100, maxWidth: 360,
    padding: 12, borderRadius: 12, background: 'var(--t-panel)', color: 'var(--t-text)', fontSize: 12, fontWeight: 300 }}>
    {status.label ? <div>To {status.label}</div> : null}<div>{status.text}</div>
    {status.error ? <div style={{ color: 'var(--t-brand-red)' }}>{status.error}</div> : null}
    {!owner.current ? <button type="button" onClick={() => setStatus(null)} style={{ background: 'transparent', border: 0, color: 'var(--t-text-muted)', paddingTop: 8, cursor: 'pointer' }}>Dismiss</button> : null}
  </div>;
}
