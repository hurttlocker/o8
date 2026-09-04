'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentMessage, AgentPresence } from '@/lib/agents/types';
import { AGENT_STATUS_ACCENT } from './AgentStatusDot';
import { SectionLabel } from './repo-focus/tabs/chats/shared';
import { REPO_FOCUS_FONT } from './repo-focus/utils';

interface AgentMessageRepo {
  name: string;
  localPath: string;
}

interface RepoSnapshot {
  repo: AgentMessageRepo;
  messages: AgentMessage[];
  agents: AgentPresence[];
}

interface AgentMessageActivityProps {
  repos: AgentMessageRepo[];
}

const COLLAPSED_KEY = 'o8:agent-panel:agent-messages-collapsed';
const SEEN_SEQUENCES_KEY = 'o8:agent-panel:agent-messages-seen';
const POLL_INTERVAL_MS = 15_000;
const MESSAGE_LIMIT = 8;

type SeenSequences = Record<string, number>;

function readSeenSequences(): SeenSequences {
  if (typeof window === 'undefined') return {};
  try {
    const value = JSON.parse(window.localStorage.getItem(SEEN_SEQUENCES_KEY) ?? '{}') as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => (
      typeof entry[1] === 'number' && Number.isFinite(entry[1])
    )));
  } catch {
    return {};
  }
}

function elapsedLabel(value: string, now: number): string {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return 'recently';
  const seconds = Math.max(0, Math.floor((now - at) / 1_000));
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function deliveryLabel(delivery: AgentMessage['delivery']): string {
  if (delivery === 'native') return 'Delivered';
  if (delivery === 'failed') return 'Delivery failed';
  return 'Queued';
}

function deliveryColor(delivery: AgentMessage['delivery']): string {
  if (delivery === 'native') return 'var(--t-text-faint)';
  if (delivery === 'failed') return AGENT_STATUS_ACCENT.failed;
  return 'var(--t-warning)';
}

function uniqueSnapshots(snapshots: RepoSnapshot[]) {
  const messages = snapshots
    .flatMap((snapshot) => snapshot.messages)
    .filter((message, index, all) => all.findIndex((candidate) => candidate.id === message.id) === index)
    .sort((left, right) => right.sequence - left.sequence)
    .slice(0, MESSAGE_LIMIT);
  const agents = snapshots
    .flatMap((snapshot) => snapshot.agents)
    .filter((agent, index, all) => all.findIndex((candidate) => candidate.agentId === agent.agentId) === index);
  return { messages, agents };
}

function AgentMessageActivityBase({ repos }: AgentMessageActivityProps) {
  const [snapshots, setSnapshots] = useState<RepoSnapshot[]>([]);
  const [refreshedAt, setRefreshedAt] = useState(0);
  const [expandedMessageId, setExpandedMessageId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === 'undefined') return true;
    const stored = window.localStorage.getItem(COLLAPSED_KEY);
    return stored === null ? true : stored === '1';
  });
  const [seenSequences, setSeenSequences] = useState<SeenSequences>(readSeenSequences);
  const abortRef = useRef<AbortController | null>(null);
  const collapsedRef = useRef(collapsed);
  const seenSequencesRef = useRef(seenSequences);

  const recordSeenSequences = useCallback((nextSnapshots: RepoSnapshot[], advanceExisting: boolean) => {
    const nextSeen = { ...seenSequencesRef.current };
    let changed = false;
    for (const snapshot of nextSnapshots) {
      const latest = snapshot.messages.reduce((highest, message) => Math.max(highest, message.sequence), 0);
      if (!(snapshot.repo.localPath in nextSeen) || (advanceExisting && latest > nextSeen[snapshot.repo.localPath])) {
        nextSeen[snapshot.repo.localPath] = latest;
        changed = true;
      }
    }
    if (!changed) return;
    seenSequencesRef.current = nextSeen;
    setSeenSequences(nextSeen);
    window.localStorage.setItem(SEEN_SEQUENCES_KEY, JSON.stringify(nextSeen));
  }, []);

  const fetchSnapshot = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const [messagesResult, presenceResult] = await Promise.allSettled([
      fetch(`/api/agents/message?scope=all&limit=${MESSAGE_LIMIT}`, { cache: 'no-store', signal: controller.signal }),
      fetch('/api/agents/presence?scope=all', { cache: 'no-store', signal: controller.signal }),
    ]);
    let messages: AgentMessage[] = [];
    let agents: AgentPresence[] = [];
    if (messagesResult.status === 'fulfilled' && messagesResult.value.ok) {
      const payload = await messagesResult.value.json() as { messages?: AgentMessage[] };
      messages = payload.messages ?? [];
    }
    if (presenceResult.status === 'fulfilled' && presenceResult.value.ok) {
      const payload = await presenceResult.value.json() as { agents?: AgentPresence[] };
      agents = payload.agents ?? [];
    }
    const reposByPath = new Map(repos.map((repo) => [repo.localPath, repo]));
    const snapshotsByPath = new Map<string, RepoSnapshot>();
    const snapshotFor = (repoPath: string) => {
      const repo = reposByPath.get(repoPath);
      if (!repo) return null;
      let snapshot = snapshotsByPath.get(repoPath);
      if (!snapshot) {
        snapshot = { repo, messages: [], agents: [] };
        snapshotsByPath.set(repoPath, snapshot);
      }
      return snapshot;
    };
    for (const message of messages) snapshotFor(message.repo)?.messages.push(message);
    for (const agent of agents) snapshotFor(agent.repo)?.agents.push(agent);
    const next = Array.from(snapshotsByPath.values());
    if (!controller.signal.aborted) {
      setSnapshots(next);
      setRefreshedAt(Date.now());
      recordSeenSequences(next, !collapsedRef.current);
    }
  }, [recordSeenSequences, repos]);

  useEffect(() => {
    if (repos.length === 0) return undefined;
    const initial = window.setTimeout(() => { void fetchSnapshot(); }, 0);
    const interval = window.setInterval(() => { void fetchSnapshot(); }, POLL_INTERVAL_MS);
    const refresh = () => { void fetchSnapshot(); };
    window.addEventListener('o8:lifecycle-reconcile', refresh);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
      window.removeEventListener('o8:lifecycle-reconcile', refresh);
      abortRef.current?.abort();
    };
  }, [fetchSnapshot, repos.length]);

  const { messages, agents } = useMemo(() => uniqueSnapshots(snapshots), [snapshots]);
  const repoNames = useMemo(() => new Map(repos.map((repo) => [repo.localPath, repo.name])), [repos]);
  const unreadCount = useMemo(() => messages.filter((message) => (
    message.sequence > (seenSequences[message.repo] ?? message.sequence)
  )).length, [messages, seenSequences]);

  const toggleCollapsed = useCallback(() => {
    const next = !collapsedRef.current;
    collapsedRef.current = next;
    setCollapsed(next);
    window.localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
    if (!next) recordSeenSequences(snapshots, true);
  }, [recordSeenSequences, snapshots]);

  if (repos.length === 0 || (messages.length === 0 && agents.length === 0)) return null;

  return (
    <section style={{ display: 'flex', flexDirection: 'column', paddingBottom: 8 }}>
      <SectionLabel
        label="Agent messages"
        compact
        count={unreadCount || undefined}
        countTone={unreadCount > 0 ? 'var(--t-accent)' : undefined}
        collapsed={collapsed}
        onToggle={toggleCollapsed}
      />
      {!collapsed ? (
        <>
          {agents.length > 0 ? (
            <div
              data-agent-presence-summary="true"
              style={{
                minHeight: 30,
                display: 'flex',
                alignItems: 'center',
                gap: 9,
                paddingTop: 5,
                paddingRight: 12,
                paddingBottom: 5,
                paddingLeft: 37,
                color: 'var(--t-text)',
                fontFamily: REPO_FOCUS_FONT,
              }}
            >
              <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: AGENT_STATUS_ACCENT.running, flexShrink: 0 }} />
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.25 }}>
                  {agents.length} agent{agents.length === 1 ? '' : 's'} live
                </span>
                <span style={{ display: 'block', marginTop: 4, color: 'var(--t-text-faint)', fontSize: 9.5, fontWeight: 260, letterSpacing: '-0.4px', lineHeight: 1.25, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {agents.map((agent) => agent.name).join(', ')}
                </span>
              </span>
            </div>
          ) : null}
          {messages.map((message) => {
            const expanded = expandedMessageId === message.id;
            const repoLabel = repoNames.get(message.repo) ?? message.repo.split('/').filter(Boolean).at(-1) ?? 'repo';
            return (
              <button
                key={message.id}
                type="button"
                data-agent-message-id={message.id}
                aria-expanded={expanded}
                onClick={() => setExpandedMessageId((current) => current === message.id ? null : message.id)}
                style={{
                  width: '100%',
                  minHeight: 44,
                  borderWidth: 0,
                  background: expanded ? 'var(--t-hover)' : 'transparent',
                  color: 'var(--t-text)',
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontFamily: REPO_FOCUS_FONT,
                  paddingTop: 5,
                  paddingRight: 12,
                  paddingBottom: 5,
                  paddingLeft: 37,
                }}
              >
                <span style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.25, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {message.from} → {message.to}
                  </span>
                </span>
                <span
                  style={{
                    display: '-webkit-box',
                    marginTop: 4,
                    color: 'var(--t-text-muted)',
                    fontSize: 11.5,
                    fontWeight: 300,
                    letterSpacing: '-0.1px',
                    lineHeight: 1.35,
                    overflow: 'hidden',
                    WebkitBoxOrient: 'vertical',
                    WebkitLineClamp: expanded ? 'unset' : 2,
                    whiteSpace: expanded ? 'pre-wrap' : 'normal',
                  }}
                >
                  {message.text}
                </span>
                <span style={{ display: 'block', marginTop: 4, color: 'var(--t-text-faint)', fontSize: 9.5, fontWeight: 260, letterSpacing: '-0.4px', lineHeight: 1.25 }}>
                  {repoLabel} · {elapsedLabel(message.timestamp, refreshedAt)} ·{' '}
                  <span style={{ color: deliveryColor(message.delivery) }}>{deliveryLabel(message.delivery)}</span>
                </span>
                {expanded && message.deliveryNote ? (
                  <span data-agent-delivery-note="true" style={{ display: 'block', marginTop: 4, color: 'var(--t-text-faint)', fontSize: 9.5, fontWeight: 260, letterSpacing: '-0.4px', lineHeight: 1.35 }}>
                    {message.deliveryNote}
                  </span>
                ) : null}
              </button>
            );
          })}
        </>
      ) : null}
    </section>
  );
}

export const AgentMessageActivity = memo(AgentMessageActivityBase);
