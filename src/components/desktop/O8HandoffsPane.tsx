'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { O8RepoSelector } from './o8-panel/O8RepoSelector';
import type { AgentMessage, AgentPresence } from '@/lib/agents/types';
import type { RepoRegistryEntry } from '@/lib/repos/types';

const POLL_MS = 15_000;
const MESSAGE_LIMIT = 50;
const TEXT_LIMIT = 4_000;

type BusErrorBody = { error?: { message?: string } };

function errorText(response: Response, body: BusErrorBody | null): string {
  if (response.status === 401 || response.status === 403) return 'Sign in as the operator to use agent handoffs.';
  return body?.error?.message ?? `Agent handoffs are unavailable (${response.status}).`;
}

function deliveryLabel(message: AgentMessage): string {
  if (message.to === 'operator') return 'Answered';
  if (message.delivery === 'failed') return 'Delivery failed';
  if (message.delivery === 'poll') return 'Waiting in inbox';
  if (message.deliveryNote?.startsWith('Read from the durable inbox')) return 'Retrieved from inbox';
  return 'Sent to terminal';
}

function exchangeGroups(messages: AgentMessage[]): Array<{ id: string; messages: AgentMessage[] }> {
  const groups = new Map<string, AgentMessage[]>();
  for (const message of messages) {
    const id = message.conversation?.id ?? `legacy:${message.id}`;
    groups.set(id, [...(groups.get(id) ?? []), message]);
  }
  return [...groups].map(([id, entries]) => ({ id, messages: entries.reverse() }));
}

function agentOptionLabel(agent: AgentPresence): string {
  const runtime = agent.runtime === 'claude-code' ? 'Claude' : agent.runtime === 'codex' ? 'Codex' : agent.runtime;
  const shortId = agent.sessionKey?.replace(/[^a-zA-Z0-9]/g, '').slice(-6).toUpperCase();
  return `@${agent.name} · ${runtime}${shortId ? ` · ${shortId}` : ''}`;
}

function agentIdentity(name: string, agents: AgentPresence[]): string {
  const agent = agents.find((entry) => entry.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  if (!agent) return `@${name}`;
  const runtime = agent.runtime === 'claude-code' ? 'Claude' : agent.runtime === 'codex' ? 'Codex' : agent.runtime;
  const shortId = agent.sessionKey?.replace(/[^a-zA-Z0-9]/g, '').slice(-6).toUpperCase();
  return `@${agent.name} · ${runtime}${shortId ? ` · ${shortId}` : ''}`;
}

const fieldStyle: CSSProperties = {
  width: '100%',
  minHeight: 34,
  boxSizing: 'border-box',
  border: '1px solid var(--t-divider)',
  borderRadius: 9,
  background: 'var(--t-input-bg)',
  color: 'var(--t-text)',
  fontFamily: 'var(--font-sans-system)',
  fontSize: 12.5,
  outline: 'none',
};

export function O8HandoffsPane({
  active,
  repoPath,
  registeredRepos,
  allRepos,
  onRepoPathChange,
  selection,
}: {
  active: boolean;
  repoPath?: string | null;
  registeredRepos: RepoRegistryEntry[];
  allRepos: boolean;
  onRepoPathChange?: (repoPath: string) => void;
  selection?: { id: string | null; request: number };
}) {
  const scopedRepo = !allRepos && repoPath && registeredRepos.some((repo) => repo.localPath === repoPath)
    ? repoPath : null;
  const [agents, setAgents] = useState<AgentPresence[]>([]);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [target, setTarget] = useState('');
  const [replyToId, setReplyToId] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(selection?.id ?? null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const sendInFlightRef = useRef(false);
  const scopedRepoRef = useRef(scopedRepo);
  scopedRepoRef.current = scopedRepo;

  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);

  useEffect(() => {
    setAgents([]);
    setMessages([]);
    setTarget('');
    setReplyToId(null);
    setComposerOpen(false);
    setDraft('');
    setError(null);
    setSendError(null);
    setActionError(null);
  }, [scopedRepo]);

  useEffect(() => {
    if (!active || !scopedRepo) return;

    const controller = new AbortController();
    const load = async () => {
      setLoading(true);
      try {
        const query = encodeURIComponent(scopedRepo);
        const [presenceResponse, messageResponse] = await Promise.all([
          fetch(`/api/agents/presence?repo=${query}`, { signal: controller.signal, cache: 'no-store' }),
          fetch(`/api/agents/message?repo=${query}&limit=${MESSAGE_LIMIT}`, { signal: controller.signal, cache: 'no-store' }),
        ]);
        const presenceBody = await presenceResponse.json() as { agents?: AgentPresence[] } & BusErrorBody;
        const messageBody = await messageResponse.json() as { messages?: AgentMessage[] } & BusErrorBody;
        if (!presenceResponse.ok) throw new Error(errorText(presenceResponse, presenceBody));
        if (!messageResponse.ok) throw new Error(errorText(messageResponse, messageBody));
        if (controller.signal.aborted) return;
        setAgents(presenceBody.agents ?? []);
        setTarget((current) => current && !presenceBody.agents?.some((agent) => agent.name === current) ? '' : current);
        setMessages(messageBody.messages ?? []);
        setError(null);
      } catch (caught) {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : 'Agent handoffs are unavailable.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    const interval = window.setInterval(() => void load(), POLL_MS);
    const onReconcile = () => void load();
    window.addEventListener('o8:lifecycle-reconcile', onReconcile);
    return () => {
      controller.abort();
      window.clearInterval(interval);
      window.removeEventListener('o8:lifecycle-reconcile', onReconcile);
    };
  }, [active, scopedRepo, refreshKey]);

  const send = async () => {
    const text = draft.trim();
    if (!scopedRepo || !target || !text || sendInFlightRef.current) return;
    sendInFlightRef.current = true;
    setSending(true);
    setSendError(null);
    try {
      const response = await fetch('/api/agents/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: scopedRepo, to: target, text, replyToId, requestId: crypto.randomUUID() }),
      });
      const body = await response.json() as { message?: AgentMessage } & BusErrorBody;
      if (!response.ok || !body.message) throw new Error(errorText(response, body));
      if (scopedRepoRef.current !== scopedRepo) return;
      setMessages((current) => [body.message!, ...current.filter((message) => message.id !== body.message!.id)].slice(0, MESSAGE_LIMIT));
      setDraft('');
      setReplyToId(null);
      setComposerOpen(false);
    } catch (caught) {
      if (scopedRepoRef.current === scopedRepo) setSendError(caught instanceof Error ? caught.message : 'Message could not be sent.');
    } finally {
      sendInFlightRef.current = false;
      setSending(false);
    }
  };

  const changeConversation = async (id: string, action: 'close' | 'extend') => {
    if (!scopedRepo || sendInFlightRef.current) return;
    sendInFlightRef.current = true;
    setSending(true);
    setActionError(null);
    try {
      const response = await fetch('/api/agents/conversation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, repo: scopedRepo, action }),
      });
      const body = await response.json() as { conversation?: unknown } & BusErrorBody;
      if (!response.ok || !body.conversation) throw new Error(errorText(response, body));
      refresh();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : 'Conversation could not be updated.');
    } finally {
      sendInFlightRef.current = false;
      setSending(false);
    }
  };

  const groups = exchangeGroups(messages);
  useEffect(() => {
    if (selection?.id) {
      setSelectedId(selection.id);
      setDetailOpen(true);
    }
  }, [selection?.id, selection?.request]);
  useEffect(() => {
    if (!detailOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDetailOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [detailOpen]);
  useEffect(() => {
    if (!groups.length) return;
    if (selectedId && !groups.some((group) => group.id === selectedId)) setSelectedId(groups[0]?.id ?? null);
    else if (!selectedId && groups.length) setSelectedId(groups[0].id);
  }, [groups, selectedId]);
  const selectedGroup = groups.find((group) => group.id === selectedId) ?? groups[0] ?? null;

  return (
    <div data-o8-handoffs="true" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: 'var(--t-bg)', color: 'var(--t-text)', fontFamily: 'var(--font-sans-system)' }}>
      <div style={{ paddingTop: 16, paddingRight: 18, paddingBottom: 14, paddingLeft: 18, borderBottom: '1px solid var(--t-divider)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 500, letterSpacing: '-0.3px' }}>Handoffs</div>
            <div style={{ marginTop: 3, color: 'var(--t-text-muted)', fontSize: 11.5, lineHeight: 1.4 }}>Agent exchanges in this repository</div>
          </div>
          <button type="button" onClick={refresh} disabled={!scopedRepo || loading} aria-label="Refresh handoffs" style={{ border: 'none', background: 'transparent', color: 'var(--t-text-muted)', cursor: scopedRepo ? 'pointer' : 'default', fontSize: 11.5 }}>Refresh</button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
          <span style={{ color: 'var(--t-text-faint)', fontSize: 10.5, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Repository</span>
          <O8RepoSelector
            repos={registeredRepos}
            allRepos={!scopedRepo}
            selectedRepoPath={scopedRepo}
            onSelectAll={() => {}}
            onSelectRepo={(path) => onRepoPathChange?.(path)}
            showAllReposOption={false}
            style={{ flex: 1 }}
          />
        </div>
      </div>

      <div role="log" aria-label="Agent exchanges" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {!scopedRepo ? (
          <div style={{ gridColumn: '1 / -1', paddingTop: 44, textAlign: 'center', color: 'var(--t-text-muted)', fontSize: 12.5, lineHeight: 1.5 }}>Choose a repository to see its agents and messages.</div>
        ) : error ? (
          <div role="alert" style={{ gridColumn: '1 / -1', padding: 14, color: 'var(--t-text-secondary)', fontSize: 12.5, lineHeight: 1.5 }}>{error}</div>
        ) : loading && messages.length === 0 ? (
          <div style={{ gridColumn: '1 / -1', color: 'var(--t-text-muted)', fontSize: 12.5, padding: 18 }}>Loading exchanges…</div>
        ) : messages.length === 0 ? (
          <div style={{ gridColumn: '1 / -1', paddingTop: 44, textAlign: 'center', color: 'var(--t-text-muted)', fontSize: 12.5, lineHeight: 1.5 }}>No agent exchanges yet. Select a live agent below to start one.</div>
        ) : (
          <>
          <nav aria-label="Conversations" style={{ minHeight: 0, background: 'var(--t-panel)' }}>
          {groups.map((group) => {
            const first = group.messages[0];
            const latest = group.messages.at(-1)!;
            const conversation = latest.conversation;
            const active = group.id === selectedGroup?.id;
            return (
              <button key={group.id} type="button" data-agent-conversation-id={conversation?.id ?? group.id} aria-pressed={active} onClick={() => { setSelectedId(group.id); setDetailOpen(true); }} style={{ display: 'block', width: '100%', minHeight: 62, paddingTop: 10, paddingRight: 12, paddingBottom: 10, paddingLeft: 12, border: 'none', borderBottom: '1px solid var(--t-divider-subtle)', background: active ? 'var(--t-panel-hover)' : 'transparent', color: 'var(--t-text)', textAlign: 'left', cursor: 'pointer' }}>
                <strong style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11.5, fontWeight: 400 }}>{agentIdentity(first.from, agents)} → {agentIdentity(first.to, agents)}</strong>
                <span style={{ display: 'block', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--t-text-muted)', fontSize: 10.5 }}>{latest.text}</span>
                <span style={{ display: 'block', marginTop: 4, color: 'var(--t-text-faint)', fontSize: 10 }}>{conversation ? `${conversation.remainingTurns} turns left · ${conversation.status}` : 'Legacy · unthreaded'} · {group.messages.length} messages</span>
              </button>
            );
          })}
          </nav>
          {detailOpen && selectedGroup && typeof document !== 'undefined' ? createPortal(<section role="dialog" aria-modal="true" aria-label="Selected conversation" style={{ position: 'fixed', inset: 0, zIndex: 10000, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--t-bg)', color: 'var(--t-text)', fontFamily: 'var(--font-sans-system)' }}>
            {(() => {
              const first = selectedGroup.messages[0];
              const latest = selectedGroup.messages.at(-1)!;
              const conversation = latest.conversation;
              return <>
                <header style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: 16, paddingRight: 24, paddingBottom: 16, paddingLeft: 24, borderBottom: '1px solid var(--t-divider)', flexShrink: 0 }}>
                  <button type="button" onClick={() => setDetailOpen(false)} style={{ minHeight: 36, paddingTop: 6, paddingRight: 12, paddingBottom: 6, paddingLeft: 12, border: '1px solid var(--t-divider)', borderRadius: 8, background: 'transparent', color: 'var(--t-text-muted)', fontSize: 11.5, cursor: 'pointer' }}>Back to Handoffs</button>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <strong style={{ display: 'block', fontSize: 15, fontWeight: 400 }}>{agentIdentity(first.from, agents)} → {agentIdentity(first.to, agents)}</strong>
                    <span style={{ display: 'block', marginTop: 3, color: 'var(--t-text-faint)', fontSize: 11 }}>{conversation ? `${conversation.remainingTurns} turns left · ${conversation.status}` : 'Legacy · unthreaded'} · {scopedRepo}</span>
                  </div>
                  {conversation?.status === 'open' ? <button type="button" disabled={sending} onClick={() => void changeConversation(conversation.id, 'close')} style={{ minHeight: 36, paddingTop: 6, paddingRight: 12, paddingBottom: 6, paddingLeft: 12, border: '1px solid var(--t-divider)', borderRadius: 8, background: 'transparent', color: 'var(--t-text-muted)', fontSize: 11.5, cursor: sending ? 'default' : 'pointer' }}>{sending ? 'Working…' : 'Stop'}</button> : null}
                  {conversation?.status === 'closed' ? <button type="button" disabled={sending} onClick={() => void changeConversation(conversation.id, 'extend')} style={{ minHeight: 36, paddingTop: 6, paddingRight: 12, paddingBottom: 6, paddingLeft: 12, border: '1px solid var(--t-divider)', borderRadius: 8, background: 'transparent', color: 'var(--t-text-muted)', fontSize: 11.5, cursor: sending ? 'default' : 'pointer' }}>{sending ? 'Working…' : 'Extend +4'}</button> : null}
                </header>
                <div data-agent-conversation-detail={conversation?.id ?? selectedGroup.id} style={{ width: 'min(920px, 100%)', alignSelf: 'center', minHeight: 0, flex: 1, overflowY: 'auto', paddingTop: 24, paddingRight: 32, paddingBottom: 32, paddingLeft: 32 }}>
                  {selectedGroup.messages.map((message) => (
                    <article key={message.id} data-agent-message-id={message.id} style={{ paddingTop: 16, paddingRight: 18, paddingBottom: 16, paddingLeft: 18, borderTop: message.id === first.id ? 'none' : '1px solid var(--t-divider-subtle)' }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
                        <strong style={{ fontSize: 12.5, fontWeight: 500 }}>{agentIdentity(message.from, agents)}</strong>
                        <span style={{ color: 'var(--t-text-faint)', fontSize: 11 }}>→ {message.to === 'operator' ? 'Operator' : agentIdentity(message.to, agents)}</span>
                        <span style={{ marginLeft: 'auto', color: 'var(--t-text-faint)', fontSize: 11, whiteSpace: 'nowrap' }}>{message.conversation ? `Turn ${message.conversation.turnIndex}/${message.conversation.turnLimit}` : 'Unthreaded'}</span>
                      </div>
                      <div style={{ marginTop: 9, fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{message.text}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 11 }}>
                        <span title={message.deliveryNote ?? undefined} style={{ flex: 1, color: message.delivery === 'failed' ? 'var(--t-danger)' : 'var(--t-text-faint)', fontSize: 11 }}>{deliveryLabel(message)} · {new Date(message.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
                        {message.id === latest.id && message.to === 'operator' && conversation?.status === 'open' && agents.some((agent) => agent.name === message.from) ? (
                          <button type="button" onClick={() => { setTarget(message.from); setReplyToId(message.id); setComposerOpen(true); setDetailOpen(false); }} style={{ minHeight: 34, paddingTop: 5, paddingRight: 10, paddingBottom: 5, paddingLeft: 10, border: '1px solid var(--t-divider)', borderRadius: 8, background: 'transparent', color: 'var(--t-accent)', fontSize: 11.5, cursor: 'pointer' }}>Reply</button>
                        ) : null}
                      </div>
                    </article>
                  ))}
                </div>
              </>;
            })()}
          </section>, document.body) : null}
          </>
        )}
      </div>

      {actionError ? <div role="alert" style={{ paddingTop: 8, paddingRight: 18, paddingBottom: 8, paddingLeft: 18, color: 'var(--t-danger)', fontSize: 11.5 }}>{actionError}</div> : null}
      <div style={{ paddingTop: composerOpen ? 14 : 10, paddingRight: 18, paddingBottom: composerOpen ? 17 : 10, paddingLeft: 18, borderTop: '1px solid var(--t-divider)', background: 'var(--t-bg)', flexShrink: 0 }}>
        {!composerOpen ? (
          <button type="button" onClick={() => setComposerOpen(true)} disabled={!scopedRepo} style={{ width: '100%', paddingTop: 9, paddingRight: 12, paddingBottom: 9, paddingLeft: 12, border: '1px solid var(--t-divider)', borderRadius: 9, background: 'var(--t-panel)', color: 'var(--t-text)', textAlign: 'left', cursor: 'pointer', fontSize: 12 }}>New handoff to a live agent</button>
        ) : (
        <>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}><strong style={{ flex: 1, fontSize: 11.5, fontWeight: 300 }}>Message an agent</strong><button type="button" onClick={() => { setComposerOpen(false); setReplyToId(null); }} style={{ border: 'none', background: 'transparent', color: 'var(--t-text-muted)', cursor: 'pointer', fontSize: 11 }}>Close</button></div>
        <label htmlFor="o8-handoff-recipient" style={{ display: 'block', marginBottom: 7, color: 'var(--t-text-muted)', fontSize: 11 }}>Send to a live agent</label>
        <select id="o8-handoff-recipient" value={target} onChange={(event) => { setTarget(event.target.value); setReplyToId(null); }} disabled={!scopedRepo || agents.length === 0 || sending} style={{ ...fieldStyle, paddingLeft: 10, paddingRight: 10 }}>
          <option value="">{agents.length === 0 ? 'No agents live in this repository' : 'Choose an agent'}</option>
          {agents.map((agent) => <option key={agent.agentId} value={agent.name}>{agentOptionLabel(agent)}</option>)}
        </select>
        {replyToId ? <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, color: 'var(--t-text-muted)', fontSize: 10.5 }}>Replying to {replyToId}<button type="button" onClick={() => setReplyToId(null)} style={{ border: 'none', background: 'transparent', color: 'var(--t-accent)', cursor: 'pointer', fontSize: 10.5 }}>Start new</button></div> : null}
        <label htmlFor="o8-handoff-message" style={{ display: 'block', marginTop: 12, marginBottom: 7, color: 'var(--t-text-muted)', fontSize: 11 }}>Message</label>
        <textarea id="o8-handoff-message" value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={TEXT_LIMIT} disabled={!scopedRepo || sending} placeholder="Give the agent a clear request or update…" rows={3} style={{ ...fieldStyle, resize: 'vertical', minHeight: 72, maxHeight: 180, paddingTop: 9, paddingRight: 10, paddingBottom: 9, paddingLeft: 10, lineHeight: 1.45 }} />
        {sendError ? <div role="alert" style={{ marginTop: 8, color: 'var(--t-danger)', fontSize: 11.5 }}>{sendError}</div> : null}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10 }}>
          <span style={{ flex: 1, color: 'var(--t-text-faint)', fontSize: 10.5, lineHeight: 1.4 }}>Sent means submitted to a terminal or held in an inbox. It does not confirm a reply.</span>
          <button type="button" onClick={() => void send()} disabled={!scopedRepo || !target || !draft.trim() || sending} style={{ paddingTop: 8, paddingRight: 14, paddingBottom: 8, paddingLeft: 14, border: 'none', borderRadius: 8, background: 'var(--t-accent)', color: 'var(--t-accent-contrast, #fff)', cursor: sending ? 'default' : 'pointer', opacity: !scopedRepo || !target || !draft.trim() || sending ? 0.45 : 1, fontSize: 11.5, fontWeight: 300, whiteSpace: 'nowrap' }}>{sending ? 'Sending…' : 'Send message'}</button>
        </div>
        </>
        )}
      </div>
    </div>
  );
}
