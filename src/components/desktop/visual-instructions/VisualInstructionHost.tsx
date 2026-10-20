'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useO8Auth } from '@/components/auth/O8AuthProvider';
import { useDictation } from '@/components/desktop/dictation/useDictation';
import { canUseTauriEvents } from '@/lib/tauri/bridge';
import { subscribeTauriEvent } from '@/lib/tauri/events';
import { claimVisualCapture, releaseVisualCapture } from '@/lib/composer/visual-capture-state';
import { visualCaptureTargets, type VisualCaptureTarget } from '@/lib/composer/visual-capture-targets';
import { readVisualDraft, restoreVisualDraft, saveVisualDraft, type VisualInstructionDraft } from '@/lib/composer/visual-draft-store';
import { currentCaptureObservation, saveCaptureSnapshot, type VisualCaptureDraftState } from '@/lib/composer/visual-capture-draft';
import { parseVisualObservation } from '@/lib/composer/visual-inspection';
import { invalidateVisualInspection } from '@/lib/composer/visual-inspection-client';
import { claimVisualAudio, subscribeVisualSpeech, subscribeVisualVoiceState, sharedVisualVoiceState, visualLiveState } from '@/lib/composer/visual-live-context';
import { snapshotVisualElements, visualElementCandidates, type VisualElementSnapshot } from '@/lib/composer/visual-element-evidence';
import { MAX_VISUAL_FRAMES, type VisualInstructionFrame } from '@/lib/composer/visual-instruction';
import { useDictationHostOptional } from '@/components/desktop/dictation/DictationHost';
import type { TimedDictationWord } from '@/components/desktop/dictation/types';
import { renderVisualCapture, type NativeVisualCapture } from '@/lib/composer/visual-capture-sequence';

interface Capture extends VisualCaptureDraftState {
  id: string; draft: VisualInstructionDraft; atMs: number; startedAt: number; label: string;
  microphoneRequested: boolean; recordingStarted: boolean; voiceError?: string; started: Promise<void>; ready: () => void; finishing: boolean; cancelled: boolean; transcript: Promise<string>; resolve: (text: string) => void;
  words?: TimedDictationWord[]; voiceOffsetMs: number; nativeStartedAt: number;
  cleanup?: Promise<unknown>; finished: Promise<void>; finishReady: () => void;
  sharedVoice: boolean; releaseAudio: () => void; before: VisualInstructionDraft; elements?: VisualElementSnapshot;
}
interface CapturedImage { dataUri: string; width: number; height: number; strokes: VisualInstructionFrame['strokes']; instruction?: string; sequence?: VisualInstructionFrame['sequence'] }
async function invoke<T>(command: string, id: string, options?: { discard: boolean }): Promise<T> {
  return (await import('@tauri-apps/api/core')).invoke<T>(command, { id, ...options });
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
    capture.cancelled = true; capture.resolve(''); capture.finishReady(); owner.current = null; releaseVisualCapture(capture.id);
    if (!capture.sharedVoice && capture.microphoneRequested) voiceRef.current.cancel();
    capture.releaseAudio(); invalidateVisualInspection(capture.draft.principal, capture.draft.request.id);
    if (readVisualDraft(capture.draft.principal, capture.draft.request.target)?.status === 'draft') void saveVisualDraft(capture.before).catch(() => {});
    void invoke('o8_visual_capture_cancel', capture.id).catch(() => {});
    setStatus(null);
  };
  const validCapture = useCallback((capture: Capture) => !capture.cancelled && accountRef.current.loaded && accountRef.current.principal === capture.draft.principal, []);
  const publishSnapshot = useCallback((capture: Capture) => saveCaptureSnapshot(capture, () => validCapture(capture) && owner.current === capture), [validCapture]);
  const refreshWords = useCallback((capture: Capture) => {
    if (!capture.finishing && owner.current === capture && currentCaptureObservation(capture)) void publishSnapshot(capture).catch(error => {
      if (owner.current === capture) setStatus({ label: capture.label, text: 'The marked draft is retained.', error: String(error) });
    });
  }, [publishSnapshot]);
  finishRef.current = async () => {
    const capture = owner.current;
    if (!capture) return;
    if (capture.finishing) return capture.finished;
    capture.finishing = true;
    setStatus({ label: capture.label, text: 'Saving marked frame…' });
    try {
      await capture.started;
      if (capture.cancelled) return;
      if (!capture.sharedVoice) {
        if (capture.recordingStarted) void voiceRef.current.stopAndSubmit();
        else { if (capture.microphoneRequested) voiceRef.current.cancel(); capture.resolve(''); }
      } else capture.resolve(capture.spoken);
      const finalizing = invoke<CapturedImage | NativeVisualCapture>('o8_visual_capture_finish', capture.id);
      void finalizing.catch(() => {});
      if (currentCaptureObservation(capture)) {
        const snapshot = await publishSnapshot(capture);
        if (!snapshot) throw new Error('The visual draft changed before it was saved.');
        // Native recording finalization and transcription never hold a usable marked draft.
        const deadline = setTimeout(() => { capture.resolve(capture.spoken); }, 90_000);
        capture.cleanup = Promise.allSettled([finalizing, capture.transcript]).finally(() => clearTimeout(deadline));
        const frozenWords = snapshot.request.utterance;
        void capture.transcript.then(async transcript => {
          const current = readVisualDraft(capture.draft.principal, capture.draft.request.target);
          if (!validCapture(capture) || current?.status !== 'draft' || current.request.id !== snapshot.request.id
            || current.request.utterance !== frozenWords || current.request.frames.at(-1)?.id !== capture.id) return;
          const words = [capture.baseWords, capture.typed, transcript].filter(Boolean).join('\n');
          if (words.length <= 16_000 && words !== frozenWords) await saveVisualDraft({ ...current, inspectionReadyAt: Date.now(),
            request: { ...current.request, utterance: words, clarification: undefined,
              frames: current.request.frames.map(frame => frame.id === capture.id ? { ...frame, transcript: transcript.slice(0, 8000) } : frame) } });
        }).catch(() => {});
        setStatus({ label: capture.label, text: 'Marked frame saved to its conversation.' });
        return;
      }
      const pixels = await finalizing;
      if (capture.cancelled || owner.current !== capture) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      const transcript = await Promise.race([capture.transcript, new Promise<string>(resolve => { timer = setTimeout(() => { timedOut = true; if (owner.current === capture && !capture.sharedVoice && capture.microphoneRequested) voiceRef.current.cancel(); resolve(''); }, 90_000); })]);
      clearTimeout(timer);
      if (capture.cancelled || accountRef.current.principal !== capture.draft.principal) return;
      const image = 'frames' in pixels ? await renderVisualCapture(pixels, capture.words, capture.voiceOffsetMs) : pixels;
      if (capture.cancelled || owner.current !== capture || accountRef.current.principal !== capture.draft.principal) return;
      const frame: VisualInstructionFrame = { id: capture.id, atMs: capture.atMs, transcript,
        image: { name: `visual-capture-${capture.draft.request.frames.length + 1}.${image.sequence ? 'jpg' : 'png'}`, dataUri: image.dataUri },
        width: image.width, height: image.height, strokes: 'strokes' in image ? image.strokes : [], pins: [], ...(image.sequence ? { sequence: image.sequence } : {}) };
      const current = readVisualDraft(capture.draft.principal, capture.draft.request.target);
      if (current && (current.request.id !== capture.draft.request.id || current.status !== 'draft')) throw new Error('The visual draft changed before this frame was saved. Capture it again.');
      const draft = current ?? capture.draft;
      const updated = { ...draft, error: undefined, request: { ...draft.request,
        clarification: undefined, utterance: [capture.baseWords, image.instruction, transcript].filter(Boolean).join('\n'), frames: draft.request.frames.some(item => item.id === capture.id) ? draft.request.frames.map(item => item.id === capture.id ? frame : item) : [...draft.request.frames, frame] } };
      if (updated.request.utterance.length > 16_000) throw new Error('The instruction exceeds the chat limit. Its recording is retained; shorten the note before sending.');
      await saveVisualDraft(updated);
      if (capture.cancelled || accountRef.current.principal !== capture.draft.principal) return;
      setStatus({ label: capture.label, text: 'Marked frame saved to its conversation.', ...(timedOut ? { error: 'Transcription timed out. Add your instruction in the chat before sending.' } : {}) });
    } catch (error) {
      capture.resolve(''); if (owner.current === capture && !capture.sharedVoice && capture.microphoneRequested) voiceRef.current.cancel();
      if (!capture.cancelled) setStatus({ label: capture.label, text: 'The frame was not added.', error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (owner.current === capture) owner.current = null;
      releaseVisualCapture(capture.id); capture.releaseAudio(); capture.finishReady();
      if (!capture.cancelled) {
        const release = () => invoke('o8_visual_capture_cancel', capture.id, { discard: false }).catch(() => {});
        if (capture.cleanup) void capture.cleanup.finally(release); else void release();
      }
    }
  };

  useEffect(() => visualCaptureTargets.subscribe((target: VisualCaptureTarget) => {
    if (owner.current) { void finishRef.current(); return; }
    if (!canUseTauriEvents() || !accountRef.current.loaded || target.principal !== accountRef.current.principal) return;
    void (async () => {
      if (dictationRef.current?.active) { setStatus({ label: target.label, text: 'Finish the current dictation before capturing a visual instruction.' }); return; }
      const selectedTemplate = target.template();
      const template = { ...selectedTemplate, routing: { ...selectedTemplate.routing, pinBackend: true as const } };
      const liveScope = { principal: target.principal, target: target.target, routing: template.routing };
      let liveState = visualLiveState(liveScope);
      if (liveState === 'other') { setStatus({ label: target.label, text: 'Another chat owns voice. Finish that session before capturing here.' }); return; }
      await restoreVisualDraft(target.principal, target.target);
      if (owner.current || !accountRef.current.loaded || target.principal !== accountRef.current.principal) return;
      liveState = visualLiveState(liveScope);
      const prior = readVisualDraft(target.principal, target.target);
      if (prior && prior.status !== 'draft' && prior.status !== 'saved') { setStatus({ label: target.label, text: 'Check the pending visual request in its chat before recording another.' }); return; }
      const draft: VisualInstructionDraft = prior?.status === 'draft' ? prior : { principal: target.principal, status: 'draft',
        template, request: { version: 1, id: crypto.randomUUID(), createdAt: new Date().toISOString(),
          target: { ...target.target }, utterance: '', frames: [] } };
      if (draft.request.frames.length >= MAX_VISUAL_FRAMES) { setStatus({ label: target.label, text: 'This instruction already has four frames. Send or remove a frame first.' }); return; }
      let resolve!: (text: string) => void;
      const transcript = new Promise<string>(done => { resolve = done; });
      let ready!: () => void;
      const started = new Promise<void>(done => { ready = done; });
      let finishReady!: () => void;
      const finished = new Promise<void>(done => { finishReady = done; });
      const capture: Capture = { id: `frame-${crypto.randomUUID()}`, draft, before: draft, label: target.label,
        finished, finishReady, revision: 0, observations: [], candidates: [], baseWords: draft.request.utterance, typed: '', spoken: '', wordsAt: Date.now(), markAt: 0, rendering: 0, sharedVoice: liveState === 'matching', releaseAudio: () => {},
        atMs: Math.min(3_600_000, Math.max(0, Date.now() - Date.parse(draft.request.createdAt))), startedAt: Date.now(), nativeStartedAt: Date.now(), voiceOffsetMs: 0, microphoneRequested: false, recordingStarted: false, started, ready, finishing: false, cancelled: false, transcript, resolve };
      claimVisualCapture(capture.id, draft.principal, draft.request.target, draft.request.id);
      try {
        capture.releaseAudio = claimVisualAudio({ id: capture.id, scope: liveScope, shared: capture.sharedVoice, prepare: async (text, afterTaskId) => {
          if (!validCapture(capture) || owner.current !== capture) throw new Error('This visual capture is no longer active.');
          if (!currentCaptureObservation(capture)) throw new Error('The latest mark has no ready pixels. Finish drawing before submitting this instruction.');
          capture.spoken = text; capture.wordsAt = Date.now();
          await finishRef.current();
          const saved = readVisualDraft(capture.draft.principal, capture.draft.request.target);
          if (!saved || saved.request.id !== capture.draft.request.id || !saved.request.frames.length) throw new Error('The marked draft was not saved.');
          const utterance = [capture.baseWords, capture.typed, text].filter(Boolean).join('\n');
          const prepared = { ...saved, request: saved.status === 'draft' ? { ...saved.request, utterance } : saved.request, template: { ...saved.template, ...(afterTaskId ? { afterTaskId } : {}) } };
          await saveVisualDraft(prepared); return prepared;
        } });
      } catch (error) { releaseVisualCapture(capture.id); setStatus({ label: target.label, text: String(error) }); return; }
      owner.current = capture;
      setStatus({ label: target.label, text: 'Capturing screen…' });
      try {
        if (prior?.status === 'saved') await saveVisualDraft(draft);
        if (capture.cancelled || owner.current !== capture || !accountRef.current.loaded || accountRef.current.principal !== target.principal) return;
        const recording = await invoke<{ startedAtMs?: number; generation?: number } | undefined>('o8_visual_capture_begin', capture.id);
        if (Number.isFinite(recording?.startedAtMs)) capture.nativeStartedAt = recording!.startedAtMs!;
        capture.nativeGeneration = recording?.generation;
        if (capture.cancelled || owner.current !== capture || !accountRef.current.loaded || accountRef.current.principal !== target.principal) { void invoke('o8_visual_capture_cancel', capture.id).catch(() => {}); return; }
        capture.ready();
        if (capture.sharedVoice) {
          setStatus({ label: target.label, text: 'Live voice is connected to this mark. Hold Shift to draw.' });
          void import('@tauri-apps/api/event').then(({ emitTo }) => emitTo('spatial-ink', 'o8:visual-capture-voice', { id: capture.id, recording: true })).catch(() => {});
          return;
        }
        setStatus({ label: target.label, text: 'Drawing is ready. Starting microphone…' });
        capture.microphoneRequested = true;
        await voiceRef.current.start({ surface: 'orchestrator', preserveTranscript: true, timedCaptureId: capture.id,
          onRecordingStart: startedAt => { capture.voiceOffsetMs = Math.max(0, startedAt - capture.nativeStartedAt); },
          context: { activeRepoPath: target.target.repoPath }, onComplete: (text, words) => { capture.words = words; capture.spoken = text; capture.wordsAt = Date.now(); resolve(text); refreshWords(capture); },
          onAbort: reason => { capture.voiceError = reason ?? 'Microphone cancelled.'; resolve(''); if (reason && !capture.finishing && owner.current === capture) setStatus({ label: target.label, text: 'Drawing is active. Type beside a circle to add your instruction.', error: reason }); } });
        capture.recordingStarted = true;
        if ((capture.cancelled || capture.finishing) && owner.current === capture) voiceRef.current.cancel();
        if (!capture.cancelled && !capture.finishing && owner.current === capture) {
          if (!capture.voiceError) setStatus({ label: target.label, text: 'Talk and use your apps. Hold Shift to mark a detail. Finish with ⌘⇧Y.' });
          void import('@tauri-apps/api/event').then(({ emitTo }) => emitTo('spatial-ink', 'o8:visual-capture-voice', { id: capture.id, recording: !capture.voiceError })).catch(() => {});
        }
      } catch (error) {
        capture.cancelled = true; capture.resolve('');
        if (owner.current === capture) { if (!capture.sharedVoice && capture.microphoneRequested) voiceRef.current.cancel(); owner.current = null; }
        releaseVisualCapture(capture.id); capture.releaseAudio();
        void invoke('o8_visual_capture_cancel', capture.id).catch(() => {});
        if (!owner.current) setStatus({ label: target.label, text: 'Capture could not start.', error: error instanceof Error ? error.message : String(error) });
      } finally { capture.ready(); }
    })().catch(error => setStatus({ label: target.label, text: 'Capture could not start.', error: error instanceof Error ? error.message : String(error) }));
  }), [validCapture, refreshWords]);

  useEffect(() => subscribeVisualVoiceState(() => {
    const capture = owner.current;
    if (!capture || !capture.sharedVoice || capture.finishing) return;
    const state = sharedVisualVoiceState({ principal: capture.draft.principal, target: capture.draft.request.target, routing: capture.draft.template.routing });
    void import('@tauri-apps/api/event').then(({ emitTo }) => emitTo('spatial-ink', 'o8:visual-capture-voice', {
      id: capture.id, recording: state === 'live', state: state === 'connecting' ? 'starting' : state === 'live' ? 'recording' : 'unavailable',
    })).catch(() => {});
    if (!state || ['closed', 'error', 'unknown'].includes(state)) setStatus({ label: capture.label, text: 'Live voice paused. Type beside the mark or finish the visual draft.' });
  }), []);
  useEffect(() => subscribeVisualSpeech(fragment => {
    const capture = owner.current;
    if (!capture || capture.finishing || !capture.sharedVoice) return;
    capture.liveSpeech = [...capture.liveSpeech ?? [], fragment].slice(-256);
    capture.spoken = (capture.spoken + fragment.text).slice(0, 8000); capture.wordsAt = Date.now(); refreshWords(capture);
  }), [refreshWords]);
  useEffect(() => {
    const capture = owner.current;
    if (!capture || capture.finishing || capture.sharedVoice || !voice.snapshot.partialTranscript) return;
    capture.spoken = voice.snapshot.partialTranscript; capture.wordsAt = Date.now(); refreshWords(capture);
  }, [voice.snapshot.partialTranscript, refreshWords]);

  useEffect(() => {
    if (!canUseTauriEvents()) return;
    const toggle = subscribeTauriEvent('o8:visual-capture-toggle', () => {
      if (owner.current) void finishRef.current();
      else if (!visualCaptureTargets.request()) setStatus({ label: '', text: 'Open and focus an existing chat before capturing a visual instruction.' });
    });
    const mark = subscribeTauriEvent<{ captureId: string; generation: number; revision: number; phase: string; removedAtMs?: number }>('o8:visual-capture-mark', ({ payload }) => {
      const capture = owner.current;
      if (!capture || capture.id !== payload.captureId || capture.nativeGeneration !== payload.generation || capture.finishing) return;
      invalidateVisualInspection(capture.draft.principal, capture.draft.request.id);
      capture.revision = payload.revision;
      if (payload.phase === 'start') { capture.elements = snapshotVisualElements(); capture.candidates = []; }
      if (payload.phase === 'end') capture.markAt = Date.now();
      if (payload.phase === 'undo') {
        capture.observations = capture.observations.filter(item => item.markedAtMs !== payload.removedAtMs);
        // Undo must not revive a different old frame as the current target.
        capture.candidates = [];
      }
    });
    const observation = subscribeTauriEvent<unknown>('o8:visual-capture-observation', ({ payload }) => {
      const value = parseVisualObservation(payload); const capture = owner.current;
      if (!value || !capture || capture.finishing || value.captureId !== capture.id || value.generation !== capture.nativeGeneration || value.revision !== capture.revision) return;
      capture.observations = [...capture.observations.filter(item => item.revision !== value.revision), value].slice(-12);
      capture.candidates = visualElementCandidates(capture.elements, value);
      refreshWords(capture);
    });
    const words = subscribeTauriEvent<{ id: string; generation: number; text: string }>('o8:visual-capture-words', ({ payload }) => {
      const capture = owner.current;
      if (!capture || capture.finishing || capture.id !== payload.id || capture.nativeGeneration !== payload.generation || typeof payload.text !== 'string') return;
      capture.typed = payload.text.slice(0, 16000); capture.wordsAt = Date.now(); refreshWords(capture);
    });
    const action = subscribeTauriEvent<{ id: string; action: string }>('o8:visual-capture-action', ({ payload }) => {
      if (payload.id !== owner.current?.id) return;
      if (payload.action === 'finish') void finishRef.current(); else if (payload.action === 'cancel') cancelRef.current();
    });
    const superseded = subscribeTauriEvent<{ id: string }>('o8:visual-capture-superseded', ({ payload }) => { if (payload.id === owner.current?.id) { const label = owner.current.label; cancelRef.current(); setStatus({ label, text: 'Another dictation took over. The earlier draft is retained; capture this frame again.' }); } });
    const failed = subscribeTauriEvent<{ id: string; generation: number; error: string }>('o8:visual-capture-error', ({ payload }) => {
      const capture = owner.current;
      if (!capture || capture.id !== payload.id || capture.nativeGeneration !== payload.generation) return;
      setStatus({ label: capture.label, text: 'Capture stopped. Keeping its original recording.', error: payload.error });
      void finishRef.current();
    });
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && owner.current) { event.preventDefault(); cancelRef.current(); } };
    window.addEventListener('keydown', escape);
    const safety = setInterval(() => { const capture = owner.current; if (capture && !capture.finishing && Date.now() - capture.startedAt > 80_000) void finishRef.current(); }, 1_000);
    return () => { toggle(); action(); superseded(); failed(); mark(); observation(); words(); window.removeEventListener('keydown', escape); clearInterval(safety); cancelRef.current(); };
  }, [refreshWords]);
  useEffect(() => { if (!auth.isLoaded || owner.current?.draft.principal !== principal) cancelRef.current(); }, [principal, auth.isLoaded]);
  if (!status) return null;
  return <div role="status" style={{ position: 'fixed', right: 20, bottom: 50, zIndex: 1100, maxWidth: 360,
    padding: 12, borderRadius: 12, background: 'var(--t-panel)', color: 'var(--t-text)', fontSize: 12, fontWeight: 300 }}>
    {status.label ? <div>To {status.label}</div> : null}<div>{status.text}</div>
    {status.error ? <div style={{ color: 'var(--t-brand-red)' }}>{status.error}</div> : null}
    {!owner.current ? <button type="button" onClick={() => setStatus(null)} style={{ background: 'transparent', border: 0, color: 'var(--t-text-muted)', paddingTop: 8, cursor: 'pointer' }}>Dismiss</button> : null}
  </div>;
}
