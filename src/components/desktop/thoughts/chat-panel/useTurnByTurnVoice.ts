'use client';

import { useCallback, useContext, useLayoutEffect, useRef, useState } from 'react';
import { useDictationHostOptional } from '@/components/desktop/dictation/DictationHost';
import { ttsEngine } from '@/lib/tts/engine';
import { ComposerVoiceTurnContext } from './ComposerVoiceTurnContext';

type Terminal = { outcome: 'completed' | 'failed' | 'interrupted' | 'unconfirmed'; text: string };
interface Options {
  binding: string;
  busy: boolean;
  send: (text: string) => { userMessageId: string } | null;
  terminals: Record<string, Terminal>;
}

/** Explicit, mount-local consent. Only this mode's own accepted user turn can be spoken. */
export function useTurnByTurnVoice(options: Options) {
  const target = useContext(ComposerVoiceTurnContext);
  const host = useDictationHostOptional();
  const [enabled, setEnabled] = useState(false);
  const [detail, setDetail] = useState('');
  const [accepted, setAccepted] = useState<{ binding: string; id: string } | null>(null);
  const current = useRef({ options, host, target });
  const consent = useRef(false);
  const pending = useRef<string | null>(null);
  const generation = useRef(0);
  const invalidate = useCallback(() => { generation.current++; }, []);
  useLayoutEffect(() => { current.current = { options, host, target }; });
  const stop = useCallback(() => {
    consent.current = false;
    generation.current++;
    pending.current = null;
    const value = current.current;
    if (value.target && value.host?.ownerId === value.target.dictationId) value.host.cancel(value.target.dictationId);
    if (ttsEngine.state.activeMessageId?.startsWith(`turn-voice:${value.options.binding}:`)) ttsEngine.stop();
    setEnabled(false);
  }, []);
  useLayoutEffect(() => {
    const binding = options.binding;
    const ownedTarget = target;
    return () => {
      consent.current = false;
      invalidate();
      pending.current = null;
      const currentHost = current.current.host;
      if (ownedTarget && currentHost?.ownerId === ownedTarget.dictationId) currentHost.cancel(ownedTarget.dictationId);
      if (ttsEngine.state.activeMessageId?.startsWith(`turn-voice:${binding}:`)) ttsEngine.stop();
      setEnabled(false);
    };
  }, [invalidate, options.binding, target]);
  useLayoutEffect(() => {
    if (!enabled || !target) return;
    const run = generation.current;
    return target.intercept(text => {
      if (!consent.current || generation.current !== run) return true;
      if (!text.trim()) return true;
      const value = current.current.options;
      if (pending.current || value.busy) { setDetail('This chat is still working. Finish this turn before recording another.'); return false; }
      const receipt = value.send(text);
      if (!receipt) { setDetail('The chat did not accept this turn. Your words remain in the draft.'); return false; }
      pending.current = receipt.userMessageId;
      setAccepted({ binding: value.binding, id: receipt.userMessageId });
      setDetail('Sent to this chat. Waiting for its confirmed result.');
      return true;
    });
  }, [enabled, target]);
  useLayoutEffect(() => {
    if (!enabled || !consent.current || !pending.current) return;
    const userMessageId = pending.current;
    const terminal = options.terminals[userMessageId];
    if (!terminal || terminal.outcome === 'unconfirmed') return;
    pending.current = null;
    const text = terminal.outcome === 'completed' ? terminal.text
      : terminal.outcome === 'interrupted' ? 'The backend confirmed interruption.'
        : terminal.text || 'The backend reported failure. Check this chat for details.';
    if (text.trim()) void ttsEngine.playNoKey(text, `turn-voice:${options.binding}:${userMessageId}`);
  }, [enabled, options.binding, options.terminals]);
  const start = useCallback(async () => {
    const value = current.current;
    if (!value.target || !value.host) { setDetail('Dictation is unavailable in this composer.'); return false; }
    if (value.host.ownerId && value.host.ownerId !== value.target.dictationId) { setDetail('Another composer owns the microphone. Finish its recording first.'); return false; }
    if (value.host.snapshotState !== 'idle') { setDetail('Finish the current dictation before starting turn-by-turn voice.'); return false; }
    if (value.options.busy || pending.current) { setDetail('Finish this chat’s current turn before starting voice.'); return false; }
    consent.current = true;
    generation.current++;
    setEnabled(true);
    setDetail('Recording a turn for this chat. Finish dictation to send it.');
    await value.host.start({ surface: 'orchestrator', onComplete: () => {} }, value.target.dictationId);
    return consent.current;
  }, []);
  const finish = useCallback(() => {
    const value = current.current;
    if (value.target && value.host?.ownerId === value.target.dictationId) value.host.stopAndSubmit(value.target.dictationId);
  }, []);
  const terminal = accepted?.binding === options.binding ? options.terminals[accepted.id] : undefined;
  const displayDetail = enabled && terminal && terminal.outcome !== 'unconfirmed'
    ? 'Turn finished. Use the microphone to record your next turn, or stop voice.' : detail;
  return { available: Boolean(target && host), enabled, detail: displayDetail, start, stop, finish,
    recording: Boolean(enabled && target && host?.ownerId === target.dictationId && host.snapshotState === 'recording') };
}
