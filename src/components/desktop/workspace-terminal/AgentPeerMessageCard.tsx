'use client';

import type { AgentMessage } from '@/lib/agents/types';

function status(message: AgentMessage): string {
  if (message.delivery === 'poll') return 'Waiting in inbox';
  if (message.delivery === 'failed') return 'Live delivery failed';
  if (message.deliveryNote?.startsWith('Read from the durable inbox')) return 'Retrieved from inbox';
  return 'Sent to terminal';
}

export function AgentPeerMessageCard({ message, selfName }: { message: AgentMessage; selfName: string }) {
  const incoming = message.to.toLocaleLowerCase() === selfName.toLocaleLowerCase();
  const counterpart = incoming ? message.from : message.to;
  return (
    <article data-agent-peer-message-id={message.id} style={{ width: '100%', maxWidth: 'min(540px, 100%)', alignSelf: incoming ? 'flex-start' : 'flex-end', paddingTop: 11, paddingRight: 13, paddingBottom: 11, paddingLeft: 13, border: '1px solid var(--t-divider)', borderRadius: 12, background: incoming ? 'var(--t-input-bg)' : 'var(--t-panel)', color: 'var(--t-text)', fontFamily: 'var(--font-sans-system)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
        <span aria-hidden="true" style={{ width: 20, height: 20, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 7, background: 'var(--t-accent-soft)', color: 'var(--t-accent)' }}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12 12 3M6 3h6v6" /></svg>
        </span>
        <strong style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11.5, fontWeight: 550 }}>{incoming ? `From ${counterpart}` : `To ${counterpart}`}</strong>
        <span style={{ color: 'var(--t-text-faint)', fontSize: 10, whiteSpace: 'nowrap' }}>#{message.sequence}</span>
      </div>
      <div style={{ marginTop: 8, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12.5, lineHeight: 1.5 }}>{message.text}</div>
      <div title={message.deliveryNote ?? undefined} style={{ marginTop: 9, color: message.delivery === 'failed' ? 'var(--t-danger)' : 'var(--t-text-faint)', fontSize: 10 }}>{status(message)} · {new Date(message.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div>
    </article>
  );
}
