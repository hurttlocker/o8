'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { LiveConversationBridge, voiceFollowupIntent } from '@/lib/voice/managed-live/conversation-bridge';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { getMobileWsToken } from '@/lib/mobile/ws-token-client';
import { startManagedLive, type LiveSession, type LiveState } from '@/lib/voice/managed-live/session';
import type { ManagedVoiceFollowup } from './managed-voice-followup';
import { voiceTerminalContext } from '@/lib/voice/managed-live/terminal-context';
import { useManagedChatVoiceTarget } from './useManagedChatVoiceTarget';
import { useManagedVoicePresentation } from './useManagedVoicePresentation';

interface Props {
  binding: string;
  messages: MobileTranscriptEntry[];
  terminals: Record<string, { outcome: 'completed' | 'failed' | 'interrupted' | 'unconfirmed'; text: string }>;
  busy: boolean;
  send: (text: string) => { userMessageId: string } | null;
  interrupt: () => void;
  followup?: ManagedVoiceFollowup;
  chatRoot?: RefObject<HTMLDivElement | null>;
  label?: string;
}
/** The selected conversation remains the only agent; voice has no tool executor. */
export function ManagedLiveButton(props: Props) {
  const terminals = useMemo(() => voiceTerminalContext(props.messages, props.terminals), [props.messages, props.terminals]);
  const [available, setAvailable] = useState(false);
  const [localPreview, setLocalPreview] = useState(false);
  const [personalTest, setPersonalTest] = useState(false);
  const [state, setState] = useState<LiveState>('idle');
  const stateRef = useRef<LiveState>('idle');
  const trigger = useRef<HTMLButtonElement>(null);
  const level = useRef(0);
  const [detail, setDetail] = useState('');
  const current = useRef(props);
  const session = useRef<LiveSession | null>(null);
  const generation = useRef(0);
  const startup = useRef<AbortController | null>(null);
  const bridge = useRef(new LiveConversationBridge());
  const pending = useRef(new Map<string, { userId: string; update: (text: string, spoken?: boolean) => Promise<void>; resolve: () => void; notified?: boolean }>());
  useEffect(() => { current.current = { ...props, terminals }; }, [props, terminals]);
  const submit = useCallback((text: string, id: string, update: (text: string, spoken?: boolean) => Promise<void>) => {
    const receipt = current.current.send(text);
    if (!receipt) { void update('The conversation did not accept the request.'); return Promise.resolve(); }
    const completion = new Promise<void>(resolve => { pending.current.set(id, { userId: receipt.userMessageId, update, resolve }); });
    void update('Request submitted to the existing conversation. Acceptance and completion are not yet confirmed.', false).catch(() => {});
    return completion;
  }, []);
  useEffect(() => {
    let alive = true;
    void fetch('/api/voice/live', { headers: { authorization: `Bearer ${getMobileWsToken()}` } })
      .then(r => r.json()).then(data => { if (alive) { setAvailable(data.enabled === true && data.entitled === true); setLocalPreview(data.transport === 'local-preview'); setPersonalTest(data.transport === 'personal-webrtc'); } }).catch(() => {});
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    generation.current++;
    const tasks = pending.current;
    return () => {
      generation.current += 1;
      startup.current?.abort();
      const closing = session.current;
      if (closing) { stateRef.current = 'closing'; void closing.close().finally(() => { stateRef.current = closing.state; }); }
      session.current = null;
      for (const item of tasks.values()) item.resolve();
      tasks.clear();
    };
  }, [props.binding]);
  useEffect(() => {
    for (const [id, item] of pending.current) {
      const terminal = terminals[item.userId];
      if (!terminal) continue;
      if (terminal.outcome === 'unconfirmed') {
        if (!item.notified) { pending.current.set(id, { ...item, notified: true }); void item.update('The backend has not confirmed completion or cancellation. Check the conversation before sending another task.').catch(() => {}); }
        continue;
      }
      pending.current.delete(id);
      const reply = terminal.outcome === 'completed' ? terminal.text || 'The backend confirmed completion without a text answer.'
        : terminal.outcome === 'interrupted' ? 'The backend confirmed interruption.' : terminal.text || 'The backend reported failure. Check the conversation for details.';
      void item.update(reply).catch(() => {}).finally(item.resolve);
    }
  }, [terminals]);
  const active = state === 'live' || state === 'connecting' || state === 'closing';
  const toggle = async () => {
    if (['live', 'connecting', 'closing'].includes(stateRef.current)) {
      if (session.current) await session.current.close();
      else { startup.current?.abort(); stateRef.current = 'closing'; setState('closing'); }
      return;
    }
    const started = ++generation.current;
    const binding = props.binding;
    const controller = new AbortController(); startup.current = controller;
    const mutationIds = new Map<string, string>();
    stateRef.current = 'connecting'; setState('connecting'); setDetail('');
    try {
      const live = await startManagedLive({ binding,
        subscribe: bridge.current.subscribe,
        context: () => {
          const userId = current.current.messages.findLast(message => message.role === 'user')?.id;
          const terminal = userId ? current.current.terminals[userId] : undefined;
          return `Backend status: ${current.current.busy ? 'working; completion not confirmed' : 'not currently reporting busy'}. Last correlated task outcome: ${terminal ? `${terminal.outcome}: ${terminal.text.slice(-600)}` : 'unknown; do not infer completion from partial text'}. Queued follow-up: ${current.current.followup?.items.map(item => `${item.status}: ${item.payload.text.slice(0, 200)}`).join('; ') || 'none'}.\n${current.current.messages.slice(-3).map(m => `${m.role}: ${m.text.slice(-400)}`).join('\n')}`;
        },
        delegate: async (text, id, update) => {
          if (current.current.binding !== binding) return;
          const reply = (message: string, spoken = true) => bridge.current.publish(message, spoken, update);
          const intent = voiceFollowupIntent(text);
      if (intent.kind === 'clarify') { await reply('That queue request includes a condition, example or withdrawal, so nothing was queued or submitted. Please give one clear follow-up request if you want it queued.'); return; }
          if (intent.kind === 'cancel') { await reply(await current.current.followup?.cancel() ?? 'The shared follow-up queue is unavailable; cancellation is not confirmed.'); return; }
          if (/^\s*(stop|cancel)(\s+(that|this|the task|working))?[.!]?\s*$/i.test(text)) {
            for (const [key, task] of pending.current) pending.current.set(key, { ...task, update: reply });
            current.current.interrupt();
            await current.current.followup?.cancel();
            // interrupt() is optimistic. Never turn its local ready state into a stop receipt.
            await reply('Stop requested. The backend has not yet confirmed cancellation.');
            return;
          }
          if (current.current.busy || pending.current.size > 0 || current.current.followup?.items.length) {
            const taskId = pending.current.values().next().value?.userId
              ?? current.current.messages.findLast(message => message.role === 'user')?.id;
            if (intent.kind === 'queue' && taskId) {
              try {
                if (!current.current.followup) throw new Error('The shared follow-up queue is unavailable.');
                if (!mutationIds.has(id)) mutationIds.set(id, `voice-${crypto.randomUUID()}`);
                await current.current.followup.enqueue(mutationIds.get(id)!, intent.text, taskId);
                await reply('Follow-up saved in this conversation for the exact task to finish. It has not been submitted or applied. Say cancel queued to remove it.');
              } catch (error) { await reply(`Follow-up submission is not confirmed. ${error instanceof Error ? error.message : 'Inspect the conversation before retrying.'}`); }
            } else {
              await reply('We can keep talking while the backend works. This runtime cannot apply an immediate correction without interrupting it, so I have not changed the task. To request a later continuation, say queue followed by the request.');
            }
            return;
          }
          await submit(intent.kind === 'queue' ? intent.text : text, id, reply);
        },
      }, (next, message) => { stateRef.current = next; if (generation.current === started) { setState(next); setDetail(message ?? ''); } }, controller.signal, { onLevel: value => { level.current = value; } });
      if (generation.current !== started) { await live.close(); setState(live.state); } else session.current = live;
    } catch { if (generation.current === started) { stateRef.current = (stateRef.current as LiveState) === 'unknown' ? 'unknown' : 'error'; setState(stateRef.current); setDetail(controller.signal.aborted ? 'Voice startup canceled. Check status before retrying.' : 'Voice could not start.'); } }
  };
  const requestToggle = useManagedChatVoiceTarget({ available, root: props.chatRoot, trigger, state: stateRef, toggle });
  useManagedVoicePresentation({ state, stateRef, session, level, label: props.label ?? 'This chat' });
  if (!available) return null;
  return <span style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
    <button ref={trigger} type="button" onClick={() => { void requestToggle().then(accepted => { if (!accepted) setDetail('Voice belongs to another chat or its closure is not confirmed.'); }); }} disabled={state === 'closing' || state === 'unknown'}
      aria-label={active ? 'Disconnect managed voice' : state === 'closed' ? 'Resume managed voice for this conversation' : 'Start managed voice for this conversation'}
      aria-pressed={active} title={detail || (localPreview ? 'Local microphone preview · Caps Lock starts and stops this chat’s preview. No provider connection or transcription.' : personalTest ? 'Personal API test · Caps Lock starts and stops GPT-Live in this chat. Your selected CLI stays in charge.' : 'Experimental · Caps Lock starts voice in this chat. Managed voice uses its own allowance; your selected CLI stays in charge.')}
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, padding: 0, background: 'transparent', color: active ? 'var(--t-accent)' : 'var(--t-text-muted)', border: 0, borderRadius: 6, cursor: state === 'closing' || state === 'unknown' ? 'default' : 'pointer' }}>
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
        <path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4" />
      </svg>
    </button>
    {detail ? <span role="status" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)' }}>{detail}</span> : null}
  </span>;
}
