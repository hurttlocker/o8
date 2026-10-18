'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { LiveConversationBridge, LiveFollowupQueue, voiceFollowupIntent } from '@/lib/voice/managed-live/conversation-bridge';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { getMobileWsToken } from '@/lib/mobile/ws-token-client';
import { startManagedLive, type LiveSession, type LiveState } from '@/lib/voice/managed-live/session';

interface Props {
  binding: string;
  messages: MobileTranscriptEntry[];
  terminals: Record<string, { outcome: 'completed' | 'failed' | 'interrupted' | 'unconfirmed'; text: string }>;
  busy: boolean;
  send: (text: string) => { userMessageId: string } | null;
  interrupt: () => void;
}
/** The selected conversation remains the only agent; voice has no tool executor. */
export function ManagedLiveButton(props: Props) {
  const [available, setAvailable] = useState(false);
  const [state, setState] = useState<LiveState>('idle');
  const [detail, setDetail] = useState('');
  const current = useRef(props);
  const session = useRef<LiveSession | null>(null);
  const generation = useRef(0);
  const startup = useRef<AbortController | null>(null);
  const bridge = useRef(new LiveConversationBridge());
  const followup = useRef(new LiveFollowupQueue());
  const pending = useRef(new Map<string, { userId: string; update: (text: string, spoken?: boolean) => Promise<void>; resolve: () => void; notified?: boolean }>());
  useEffect(() => { current.current = props; }, [props]);
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
      .then(r => r.json()).then(data => { if (alive) setAvailable(data.enabled === true && data.entitled === true); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    generation.current++;
    const tasks = pending.current;
    const queued = followup.current;
    return () => {
      generation.current += 1;
      startup.current?.abort();
      void session.current?.close(); session.current = null;
      for (const item of tasks.values()) item.resolve();
      tasks.clear(); queued.cancel();
    };
  }, [props.binding]);
  useEffect(() => {
    for (const [id, item] of pending.current) {
      const terminal = props.terminals[item.userId];
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
    const queued = followup.current.pending;
    if (queued && !props.busy && pending.current.size === 0) {
      const terminal = props.terminals[queued.afterTaskId];
      if (!terminal || terminal.outcome === 'unconfirmed') return;
      const latestUser = props.messages.findLast(message => message.role === 'user');
      if (latestUser?.id !== queued.afterTaskId) {
        followup.current.cancel();
        void bridge.current.publish('Queued follow-up was not sent because the active task changed. Please confirm it again.').catch(() => {});
        return;
      }
      const next = followup.current.take(queued.afterTaskId, true);
      if (next) void submit(next.text, next.id, bridge.current.publish).catch(() => {});
    }
  }, [props.terminals, props.busy, props.messages, submit]);
  if (!available) return null;
  const active = state === 'live' || state === 'connecting' || state === 'closing';
  const toggle = async () => {
    if (active) {
      if (session.current) await session.current.close();
      else { startup.current?.abort(); setState('closing'); }
      return;
    }
    const started = ++generation.current;
    const binding = props.binding;
    const controller = new AbortController(); startup.current = controller;
    setState('connecting'); setDetail('');
    try {
      const live = await startManagedLive({ binding,
        subscribe: bridge.current.subscribe,
        context: () => {
          const userId = current.current.messages.findLast(message => message.role === 'user')?.id;
          const terminal = userId ? current.current.terminals[userId] : undefined;
          return `Backend status: ${current.current.busy ? 'working; completion not confirmed' : 'not currently reporting busy'}. Last correlated task outcome: ${terminal ? `${terminal.outcome}: ${terminal.text.slice(-600)}` : 'unknown; do not infer completion from partial text'}. Queued follow-up: ${followup.current.pending?.text.slice(0, 400) ?? 'none'}.\n${current.current.messages.slice(-3).map(m => `${m.role}: ${m.text.slice(-400)}`).join('\n')}`;
        },
        delegate: async (text, id, update) => {
          if (current.current.binding !== binding) return;
          const reply = (message: string, spoken = true) => bridge.current.publish(message, spoken, update);
          const intent = voiceFollowupIntent(text);
      if (intent.kind === 'clarify') { await reply('That queue request includes a condition, example or withdrawal, so nothing was queued or submitted. Please give one clear follow-up request if you want it queued.'); return; }
          if (intent.kind === 'cancel') { await reply(followup.current.cancel() ? 'Queued follow-up canceled before submission. The running task is unchanged.' : 'There is no queued follow-up. The running task is unchanged.'); return; }
          if (/^\s*(stop|cancel)(\s+(that|this|the task|working))?[.!]?\s*$/i.test(text)) {
            for (const [key, task] of pending.current) pending.current.set(key, { ...task, update: reply });
            followup.current.cancel();
            current.current.interrupt();
            // interrupt() is optimistic. Never turn its local ready state into a stop receipt.
            await reply('Stop requested. The backend has not yet confirmed cancellation.');
            return;
          }
          if (current.current.busy || pending.current.size > 0) {
            const taskId = pending.current.values().next().value?.userId
              ?? current.current.messages.findLast(message => message.role === 'user')?.id;
            if (intent.kind === 'queue' && taskId) {
              const accepted = followup.current.enqueue(id, intent.text, taskId);
              await reply(accepted ? 'Follow-up queued for this task to finish. It has not been submitted or applied, and the current task continues unchanged. Say cancel queued to remove it.' : 'A follow-up is already queued. Cancel it before replacing it.');
            } else {
              await reply('We can keep talking while the backend works. This runtime cannot apply an immediate correction without interrupting it, so I have not changed the task. To request a later continuation, say queue followed by the request.');
            }
            return;
          }
          await submit(intent.kind === 'queue' ? intent.text : text, id, reply);
        },
      }, (next, message) => { if (generation.current === started) { setState(next); setDetail(message ?? ''); } }, controller.signal);
      if (generation.current !== started) { await live.close(); setState(live.state); } else session.current = live;
    } catch { if (generation.current === started) { setState('error'); setDetail(controller.signal.aborted ? 'Voice startup canceled. Check status before retrying.' : 'Voice could not start.'); } }
  };
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
    <button type="button" onClick={() => { void toggle(); }} disabled={state === 'closing'}
      aria-label={active ? 'Disconnect managed voice' : state === 'closed' ? 'Resume managed voice for this conversation' : 'Start managed voice for this conversation'}
      aria-pressed={active} title={detail || 'Managed voice uses a separate voice allowance. Your selected agent stays in charge.'}
      style={{ background: 'transparent', color: 'var(--t-text-muted)', border: '1px solid var(--t-border)', borderRadius: 6, fontSize: 11, fontWeight: 300, paddingTop: 3, paddingBottom: 3, paddingLeft: 6, paddingRight: 6 }}>
      {state === 'connecting' ? 'Connecting voice…' : state === 'closing' ? 'Closing voice…' : active ? 'Disconnect voice' : state === 'closed' ? 'Resume voice' : 'Voice'}
    </button>
    {detail ? <span role="status" style={{ color: 'var(--t-text-muted)', fontSize: 11 }}>{detail}</span> : null}
  </span>;
}
