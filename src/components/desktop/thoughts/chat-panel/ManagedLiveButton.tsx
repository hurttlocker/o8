'use client';

import { useEffect, useRef, useState } from 'react';
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
  const pending = useRef(new Map<string, { userId: string; update: (text: string, spoken?: boolean) => Promise<void>; resolve: () => void; notified?: boolean }>());
  useEffect(() => { current.current = props; }, [props]);
  useEffect(() => {
    let alive = true;
    void fetch('/api/voice/live', { headers: { authorization: `Bearer ${getMobileWsToken()}` } })
      .then(r => r.json()).then(data => { if (alive) setAvailable(data.enabled === true && data.entitled === true); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    generation.current++;
    const tasks = pending.current;
    return () => {
      generation.current += 1;
      startup.current?.abort();
      void session.current?.close(); session.current = null;
      for (const item of tasks.values()) item.resolve();
      tasks.clear();
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
  }, [props.terminals]);
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
        context: () => current.current.messages.slice(-12).map(m => `${m.role}: ${m.text}`).join('\n'),
        delegate: async (text, id, update) => {
          if (current.current.binding !== binding) return;
          if (/^\s*(stop|cancel)(\s+(that|this|the task|working))?[.!]?\s*$/i.test(text)) {
            for (const [key, task] of pending.current) pending.current.set(key, { ...task, update });
            current.current.interrupt();
            // interrupt() is optimistic. Never turn its local ready state into a stop receipt.
            await update('Stop requested. The backend has not yet confirmed cancellation.');
            return;
          }
          if (current.current.busy || pending.current.size > 0) {
            await update('The existing task is still running. Use the conversation steering control to apply this correction; I have not started another task.');
            return;
          }
          const receipt = current.current.send(text);
          if (!receipt) { await update('The conversation did not accept the request.'); return; }
          const completion = new Promise<void>(resolve => { pending.current.set(id, { userId: receipt.userMessageId, update, resolve }); });
          void update('Request submitted to the existing conversation. Completion is not yet confirmed.', false).catch(() => {});
          await completion;
        },
      }, (next, message) => { if (generation.current === started) { setState(next); setDetail(message ?? ''); } }, controller.signal);
      if (generation.current !== started) { await live.close(); setState(live.state); } else session.current = live;
    } catch { if (generation.current === started) { setState('error'); setDetail(controller.signal.aborted ? 'Voice startup canceled. Check status before retrying.' : 'Voice could not start.'); } }
  };
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
    <button type="button" onClick={() => { void toggle(); }} disabled={state === 'closing'}
      aria-label={active ? 'Disconnect managed voice' : 'Start managed voice for this conversation'}
      aria-pressed={active} title={detail || 'Managed voice uses a separate voice allowance. Your selected agent stays in charge.'}
      style={{ background: 'transparent', color: 'var(--t-text-muted)', border: '1px solid var(--t-border)', borderRadius: 6, fontSize: 11, fontWeight: 300, paddingTop: 3, paddingBottom: 3, paddingLeft: 6, paddingRight: 6 }}>
      {state === 'connecting' ? 'Connecting voice…' : state === 'closing' ? 'Closing voice…' : active ? 'Disconnect voice' : 'Voice'}
    </button>
    {detail ? <span role="status" style={{ color: 'var(--t-text-muted)', fontSize: 11 }}>{detail}</span> : null}
  </span>;
}
