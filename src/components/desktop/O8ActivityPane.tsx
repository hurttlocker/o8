'use client';

/**
 * O8ActivityPane — Activity feed for the O8 Panel right-side panel.
 *
 * Fetches commits, PRs, issues, and CI runs from the panel API endpoints
 * AND folds in orchestrator packets + auto-directive proposals from
 * mission state. Renders a unified, chronological timeline with segmented
 * filter pills and a repo selector dropdown.
 *
 * As of the Mission-rail consolidation (commit 2), packets render
 * unconditionally and the directive proposals section is pinned above the
 * timeline. The right-side Mission rail in OrchestratorTab is deleted —
 * Activity is the single mission-control surface.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ActivityItem } from './agent-panel/types';
import { shortRepoLabel, normalizeRepoSlug } from './agent-panel/shared';
import { openExternalUrl } from '@/lib/desktop/open-external';
import {
  ACTIVITY_COLORS,
  EMPTY_DATA,
  FILTER_TABS,
  IconZap,
  feedIconForItem,
  fetchRepoActivity,
  itemBadge,
  itemKey,
  itemSubline,
  itemTitle,
  renderExpandedDetail,
  useExpandDetails,
  type O8FeedFilter,
  type RepoActivityData,
} from './o8-activity-helpers';
import { repoSlugFromRemote } from './canvas-utils';
import { useOrchestratorData } from './orchestrator-data-context';
import { O8ActivityPacketRow } from './o8-panel/O8ActivityPacketRow';
import { O8RepoSelector } from './o8-panel/O8RepoSelector';
import { O8ScratchChat } from './o8-panel/workspace-rail/O8ScratchChat';
import { PrPanel } from './pr-panel/PrPanel';
import { DirectiveProposalRow } from './thoughts/DirectiveProposalRow';
import { useDirectiveProposals } from './thoughts/mission-panel/useDirectiveProposals';
import type { DirectiveProposalCandidate } from './thoughts/directive-proposal-types';
import type { RepoRegistryEntry } from '@/lib/repos/types';

const PROPOSALS_OPEN_KEY = 'o8:activity:proposals-open';
const PROPOSALS_SEEN_KEY = 'o8:activity:proposals-seen';

/** Operator-seen proposal ids. Persisted so the "new" emphasis clears across
 *  reloads once reviewed. Always read in an effect, never in render, to avoid
 *  an SSR/CSR hydration mismatch (see the MergePreviewCycler regression). */
function readSeenProposalIds(): Set<string> {
  try {
    const raw = window.localStorage.getItem(PROPOSALS_SEEN_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((x): x is string => typeof x === 'string'))
      : new Set();
  } catch {
    return new Set();
  }
}

function markProposalsSeen(ids: string[]) {
  if (ids.length === 0) return;
  try {
    const merged = readSeenProposalIds();
    for (const id of ids) merged.add(id);
    // Cap so the list can't grow unbounded as proposals churn over time.
    const capped = Array.from(merged).slice(-200);
    window.localStorage.setItem(PROPOSALS_SEEN_KEY, JSON.stringify(capped));
  } catch {
    // ignore
  }
}

const FILTER_TABS_WITH_PACKETS = [
  ...FILTER_TABS,
  { key: 'packet' as O8FeedFilter, label: 'Packets', icon: (c: string) => <IconZap size={11} color={c} /> },
];

/** Returns epoch milliseconds parsed from an optional ISO date string, or null when absent or unparseable. */
function parseTs(value?: string | null): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// ── Component ──

interface O8ActivityPaneProps {
  repoPath?: string | null;
  repoSlug?: string | null;
  registeredRepos?: RepoRegistryEntry[];
  allRepos?: boolean;
  onSelectAllRepos?: () => void;
  onSelectRepoPath?: (repoPath: string) => void;
  onSelectCommit?: (hash: string, meta?: Record<string, string>) => void;
  onSelectIssue?: (issueNumber: number, repo?: string) => void;
  selectedPrNumber?: number | null;
  selectedPrRepo?: string | null;
}

export const O8ActivityPane = memo(function O8ActivityPane({
  repoPath,
  repoSlug,
  registeredRepos: registeredRepoEntries = [],
  allRepos = false,
  onSelectAllRepos,
  onSelectRepoPath,
  onSelectCommit,
  onSelectIssue,
  selectedPrNumber,
  selectedPrRepo,
}: O8ActivityPaneProps) {
  const [data, setData] = useState<RepoActivityData>(EMPTY_DATA);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<O8FeedFilter>('all');
  const [fallbackRepoOptions, setFallbackRepoOptions] = useState<string[]>([]);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [proposalsOpen, setProposalsOpen] = useState(false);
  // Frozen-per-mount set of proposal ids the operator had already seen.
  // Empty on the server / first paint (hydration-safe), filled in an effect.
  const [seenProposalSnapshot, setSeenProposalSnapshot] = useState<Set<string>>(() => new Set());
  const proposalAutoOpenedRef = useRef(false);
  const persistedSeenSigRef = useRef('');
  const [selectedPr, setSelectedPr] = useState<{ number: number; repo: string | null } | null>(() => (
    selectedPrNumber ? { number: selectedPrNumber, repo: selectedPrRepo ?? repoSlug ?? null } : null
  ));

  useEffect(() => {
    setSelectedPr(selectedPrNumber ? { number: selectedPrNumber, repo: selectedPrRepo ?? repoSlug ?? null } : null);
  }, [repoSlug, selectedPrNumber, selectedPrRepo]);

  // Hydrate the proposals open/closed pref after mount so SSR doesn't
  // hydrate-mismatch. Default = collapsed; the row is recommendations,
  // not pending tasks, so it shouldn't dominate the timeline visually.
  useEffect(() => {
    try {
      setProposalsOpen(window.localStorage.getItem(PROPOSALS_OPEN_KEY) === '1');
      setSeenProposalSnapshot(readSeenProposalIds());
    } catch {
      // ignore
    }
  }, []);
  const handleToggleProposals = useCallback(() => {
    setProposalsOpen((prev) => {
      const next = !prev;
      try { window.localStorage.setItem(PROPOSALS_OPEN_KEY, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  }, []);
  const { prDetails, ciDetails, fetchForItem } = useExpandDetails();
  const mountedRef = useRef(true);
  const orchestratorData = useOrchestratorData();
  const missionPackets = orchestratorData?.missionState?.packets;

  // #746 — directive proposals are surfaced above the timeline as
  // recommendations. Accept routes through OrchestratorDataContext so the
  // orchestrator chat composer pre-fills with the proposed directive.
  const handleAcceptDirectiveProposal = useCallback((proposal: DirectiveProposalCandidate) => {
    const draftText = [
      proposal.source === 'observation'
        ? 'Please review and promote the following worker observation if it is worth keeping:'
        : 'Please save the following directive after I review it:',
      '',
      proposal.draftDirective,
    ].join('\n');
    orchestratorData?.onAcceptDirectiveProposal?.({
      id: `proposal-accept-${proposal.id}-${Date.now()}`,
      text: draftText,
    });
  }, [orchestratorData]);

  const {
    proposals,
    pendingProposalId,
    handleAccept: handleAcceptProposal,
    handleDismiss: handleDismissProposal,
  } = useDirectiveProposals({
    open: true,
    visible: true,
    retryNonce: 0,
    onAccept: handleAcceptDirectiveProposal,
  });

  // #9 — unread / actionable hierarchy. Proposals not in the frozen seen
  // snapshot read as "new": accent dot + border on the row, accent header,
  // and a one-time auto-open so they aren't buried. We persist "seen" once
  // the section is open (clears the emphasis on the NEXT load) but keep the
  // snapshot frozen this session so opening doesn't make "N new" vanish
  // while the operator is still looking.
  const newProposalIds = useMemo(
    () => new Set(proposals.filter((p) => !seenProposalSnapshot.has(p.id)).map((p) => p.id)),
    [proposals, seenProposalSnapshot],
  );
  const unreadProposalCount = newProposalIds.size;

  useEffect(() => {
    if (proposalAutoOpenedRef.current || unreadProposalCount === 0) return;
    proposalAutoOpenedRef.current = true;
    setProposalsOpen(true);
  }, [unreadProposalCount]);

  useEffect(() => {
    if (!proposalsOpen || proposals.length === 0) return;
    // Persist only when the proposal set changes — the hook may hand us a
    // fresh array reference each render, and we don't want a localStorage
    // write on every one.
    const sig = proposals.map((p) => p.id).sort().join('|');
    if (persistedSeenSigRef.current === sig) return;
    persistedSeenSigRef.current = sig;
    markProposalsSeen(proposals.map((p) => p.id));
  }, [proposalsOpen, proposals]);

  const registeredRepos = useMemo(() => {
    const slugs = registeredRepoEntries
      .map((entry) => repoSlugFromRemote(entry.remoteUrl) ?? normalizeRepoSlug(entry.name))
      .filter((slug): slug is string => Boolean(slug));
    return Array.from(new Set(slugs));
  }, [registeredRepoEntries]);

  const repoOptions = registeredRepos.length > 0 ? registeredRepos : fallbackRepoOptions;

  // Fallback for legacy callers/tests that do not pass the dashboard registry.
  useEffect(() => {
    if (registeredRepos.length > 0) return;
    let cancelled = false;
    fetch('/api/panel/repos')
      .then((res) => res.json())
      .then((d) => {
        const slugs = (d.repos ?? [])
          .map((r: { remoteUrl?: string | null; name?: string | null }) => {
            return repoSlugFromRemote(r.remoteUrl) ?? normalizeRepoSlug(r.name);
          })
          .filter(Boolean) as string[];
        if (!cancelled && mountedRef.current) setFallbackRepoOptions(Array.from(new Set(slugs)));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [registeredRepos.length]);

  // Resolve the focused repo's slug from the shared scope (a localPath) so the
  // feed fetch keys off the same repo the Workspace tab + left switcher show.
  const selectedSlug = useMemo(() => {
    if (!repoPath) return null;
    const entry = registeredRepoEntries.find((e) => e.localPath === repoPath);
    if (!entry) return null;
    return repoSlugFromRemote(entry.remoteUrl) ?? normalizeRepoSlug(entry.name);
  }, [repoPath, registeredRepoEntries]);

  const effectiveRepo = useMemo(() => {
    if (selectedSlug) return selectedSlug;
    const normalized = normalizeRepoSlug(repoSlug);
    if (normalized) return normalized;
    if (repoOptions.length > 0) return repoOptions[0];
    return null;
  }, [selectedSlug, repoSlug, repoOptions]);

  const isAllRepos = allRepos;

  // Fetch activity data
  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        if (isAllRepos) {
          const results = await Promise.all(
            repoOptions.map((slug) => fetchRepoActivity(slug).catch(() => EMPTY_DATA))
          );
          if (cancelled) return;
          const merged: RepoActivityData = { commits: [], prs: [], issues: [], ciRuns: [] };
          for (const r of results) {
            merged.commits.push(...r.commits);
            merged.prs.push(...r.prs);
            merged.issues.push(...r.issues);
            merged.ciRuns.push(...r.ciRuns);
          }
          setData(merged);
        } else if (effectiveRepo) {
          const result = await fetchRepoActivity(effectiveRepo);
          if (cancelled) return;
          setData(result);
        } else {
          setData(EMPTY_DATA);
        }
      } catch {
        if (!cancelled) setData(EMPTY_DATA);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();

    // WS-driven invalidation + 5min fallback
    const handler = () => { void load(); };
    window.addEventListener('o8:realtime', handler);
    window.addEventListener('o8:agent-lifecycle', handler);
    window.addEventListener('o8:lane-lifecycle', handler);
    const fallbackId = setInterval(handler, 300_000);

    return () => {
      cancelled = true;
      window.removeEventListener('o8:realtime', handler);
      window.removeEventListener('o8:agent-lifecycle', handler);
      window.removeEventListener('o8:lane-lifecycle', handler);
      clearInterval(fallbackId);
    };
  }, [effectiveRepo, isAllRepos, repoOptions]);

  // Packet items are derived from orchestrator missionState (not the
  // /api/panel feed). Always-on as of commit 2 — Mission rail is gone, so
  // Activity is the single read for "what packets are live."
  const packetItems = useMemo<ActivityItem[]>(() => {
    if (!missionPackets) return [];
    const items: ActivityItem[] = [];
    for (const packet of missionPackets) {
      if (packet.archivedAt) continue;
      // Comparison-group siblings — render only the leader, like the
      // Mission rail used to do via ComparisonCard.
      if (packet.comparisonGroupId && packet.comparisonIndex && packet.comparisonIndex > 0) continue;
      const ts = parseTs(packet.lane?.lastEventAt) ?? parseTs(packet.lastEventAt) ?? Date.now();
      items.push({ kind: 'packet', packet, ts, repo: packet.workspaceTargetPath ?? undefined });
    }
    return items;
  }, [missionPackets]);

  // Build sorted timeline
  const allItems = useMemo<ActivityItem[]>(() => {
    const timeline = [...data.commits, ...data.prs, ...data.issues, ...data.ciRuns, ...packetItems];
    timeline.sort((a, b) => b.ts - a.ts);
    return timeline.slice(0, 50);
  }, [data, packetItems]);

  const counts = useMemo(() => {
    const c: Record<O8FeedFilter, number> = { all: allItems.length, commit: 0, issue: 0, pr: 0, ci: 0, packet: 0 };
    for (const item of allItems) {
      if (item.kind in c) c[item.kind as O8FeedFilter]++;
    }
    return c;
  }, [allItems]);

  const filtered = useMemo(() => {
    if (filter === 'all') return allItems;
    return allItems.filter((item) => item.kind === filter);
  }, [allItems, filter]);

  // Group by day
  const grouped = useMemo(() => {
    const groups: Array<{ label: string; items: ActivityItem[] }> = [];
    let currentLabel = '';
    const today = new Date().toDateString();
    const yesterday = new Date(Date.now() - 86400000).toDateString();

    for (const item of filtered) {
      const dateLabel = new Date(item.ts).toDateString();
      const label = dateLabel === today
        ? 'Today'
        : dateLabel === yesterday
          ? 'Yesterday'
          : new Date(item.ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      if (label !== currentLabel) {
        groups.push({ label, items: [] });
        currentLabel = label;
      }
      groups[groups.length - 1].items.push(item);
    }
    return groups;
  }, [filtered]);

  const handleItemClick = useCallback((item: ActivityItem) => {
    if (item.kind === 'commit') {
      onSelectCommit?.(item.hash, item.repo ? { repo: item.repo } : undefined);
    } else if (item.kind === 'pr') {
      setSelectedPr({ number: item.number, repo: item.repo ?? null });
    } else if (item.kind === 'issue') {
      if (onSelectIssue) {
        onSelectIssue(item.number, item.repo);
      } else {
        openExternalUrl(`https://github.com/${item.repo}/issues/${item.number}`);
      }
    } else if (item.kind === 'ci') {
      openExternalUrl(`https://github.com/${item.repo}/actions/runs/${item.id}`);
    }
  }, [onSelectCommit, onSelectIssue]);

  if (selectedPr) {
    return (
      <PrPanel
        prNumber={selectedPr.number}
        repoSlug={selectedPr.repo ?? repoSlug ?? null}
        repoPath={repoPath ?? null}
        onClose={() => setSelectedPr(null)}
      />
    );
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      overflow: 'hidden',
    }}>
      {/* Header: repo selector + filter pills */}
      <div style={{
        paddingTop: 10,
        paddingRight: 12,
        paddingBottom: 8,
        paddingLeft: 12,
        borderBottom: '1px solid var(--t-divider)',
        flexShrink: 0,
      }}>
        {/* Repo selector */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <O8RepoSelector
            repos={registeredRepoEntries}
            allRepos={allRepos}
            selectedRepoPath={repoPath ?? null}
            onSelectAll={() => onSelectAllRepos?.()}
            onSelectRepo={(path) => onSelectRepoPath?.(path)}
            style={{ flex: 1, minWidth: 0 }}
          />
          <O8ScratchChat
            repoPath={repoPath ?? null}
            selectedFile={null}
            surface="diff"
            placement="review-toolbar"
          />
        </div>

        {/* Filter pills */}
        <div style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          paddingTop: 3,
          paddingRight: 3,
          paddingBottom: 3,
          paddingLeft: 3,
          borderRadius: 10,
          border: '0.5px solid var(--t-divider-subtle)',
          background: 'var(--t-panel)',
        }}>
          {FILTER_TABS_WITH_PACKETS.map((tab) => {
            const active = filter === tab.key;
            const count = counts[tab.key];
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setFilter(tab.key)}
                title={tab.label}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  paddingTop: 3,
                  paddingRight: 8,
                  paddingBottom: 3,
                  paddingLeft: 6,
                  borderRadius: 999,
                  border: 'none',
                  background: active ? ACTIVITY_COLORS.accentBg : 'transparent',
                  color: active ? ACTIVITY_COLORS.accent : 'var(--t-text-muted)',
                  fontSize: 11,
                  fontWeight: 350,
                  cursor: 'pointer',
                  fontFamily: 'var(--font-sans-system)',
                  transition: 'all 120ms cubic-bezier(0.22, 1, 0.36, 1)',
                  letterSpacing: '-0.1px',
                }}
              >
                {tab.icon(active ? ACTIVITY_COLORS.accent : 'var(--t-text-muted)')}
                {tab.label}
                {count > 0 && tab.key !== 'all' ? (
                  <span style={{
                    fontSize: 9.5,
                    fontWeight: 260,
                    letterSpacing: '-0.4px',
                    color: active ? ACTIVITY_COLORS.accent : 'var(--t-text-faint)',
                    fontFamily: 'var(--font-sans-system)',
                  }}>
                    {count}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      {/* Activity list */}
      <div className="cortex-scroll-fade-y cortex-themed-scroll" style={{
        flex: 1,
        overflowY: 'auto',
        overflowX: 'hidden',
      }}>
        {/* #746 / #9 — directive proposals pin above the timeline as
            recommendations (system → operator), distinct from the feed.
            Unseen ("new") proposals get accent emphasis + a one-time
            auto-open; once reviewed they stay listed but read calmly. */}
        {proposals.length > 0 ? (
          <div style={{ paddingTop: 8, paddingRight: 12, paddingLeft: 12 }}>
            <button
              type="button"
              onClick={handleToggleProposals}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                paddingTop: 6,
                paddingRight: 8,
                paddingBottom: 6,
                paddingLeft: 8,
                borderRadius: 8,
                borderWidth: 0,
                background: unreadProposalCount > 0
                  ? 'var(--t-accent-soft)'
                  : proposalsOpen ? 'var(--t-hover)' : 'transparent',
                cursor: 'pointer',
                textAlign: 'left',
                fontFamily: 'var(--font-sans-system)',
                transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1)',
              }}
              onMouseEnter={(e) => { if (unreadProposalCount === 0 && !proposalsOpen) e.currentTarget.style.background = 'var(--t-hover)'; }}
              onMouseLeave={(e) => { if (unreadProposalCount === 0 && !proposalsOpen) e.currentTarget.style.background = 'transparent'; }}
              aria-expanded={proposalsOpen}
              title={proposalsOpen ? 'Hide proposed directives' : 'Show proposed directives'}
            >
              <span
                style={{
                  width: 10,
                  height: 10,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: unreadProposalCount > 0 ? 'var(--t-accent)' : 'var(--t-text-faint)',
                  transition: 'transform 150ms cubic-bezier(0.22, 1, 0.36, 1)',
                  transform: proposalsOpen ? 'rotate(90deg)' : 'rotate(0deg)',
                  flexShrink: 0,
                }}
              >
                <svg width="7" height="7" viewBox="0 0 7 7" fill="currentColor"><path d="M1.5 0.5L5.5 3.5L1.5 6.5Z" /></svg>
              </span>
              <span
                style={{
                  fontSize: 9,
                  fontWeight: 300,
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                  color: unreadProposalCount > 0 ? 'var(--t-accent)' : 'var(--t-text-faint)',
                  flex: 1,
                  minWidth: 0,
                }}
              >
                Proposed directives
              </span>
              {unreadProposalCount > 0 ? (
                <span
                  title="New proposals you haven't reviewed yet"
                  style={{
                    paddingTop: 1,
                    paddingRight: 7,
                    paddingBottom: 1,
                    paddingLeft: 7,
                    borderRadius: 999,
                    background: 'var(--t-accent)',
                    color: '#fff',
                    fontSize: 9.5,
                    fontWeight: 350,
                    letterSpacing: '-0.1px',
                    flexShrink: 0,
                  }}
                >
                  {unreadProposalCount} new
                </span>
              ) : (
                <span
                  title="Surfaced when the same fix-pattern appears 3+ times in the last 14 days"
                  style={{
                    paddingTop: 1,
                    paddingRight: 6,
                    paddingBottom: 1,
                    paddingLeft: 6,
                    borderRadius: 999,
                    background: 'var(--t-hover)',
                    color: 'var(--t-text-faint)',
                    fontSize: 9.5,
                    fontWeight: 260,
                    letterSpacing: '-0.4px',
                    flexShrink: 0,
                  }}
                >
                  {proposals.length}
                </span>
              )}
            </button>
            {proposalsOpen ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4, marginBottom: 4 }}>
                {proposals.map((proposal) => (
                  <DirectiveProposalRow
                    key={proposal.id}
                    proposal={proposal}
                    onAccept={handleAcceptProposal}
                    onDismiss={handleDismissProposal}
                    busy={pendingProposalId === proposal.id}
                    isNew={newProposalIds.has(proposal.id)}
                  />
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        {loading ? (
          <div style={{
            paddingTop: 32,
            paddingBottom: 32,
            textAlign: 'center',
            fontSize: 13,
            fontWeight: 300,
            color: 'var(--t-text-faint)',
            lineHeight: 1.45,
            letterSpacing: '-0.1px',
          }}>
            Loading activity...
          </div>
        ) : filtered.length === 0 ? (
          <div style={{
            paddingTop: 32,
            paddingBottom: 32,
            textAlign: 'center',
            fontSize: 13,
            fontWeight: 300,
            color: 'var(--t-text-faint)',
            lineHeight: 1.45,
            letterSpacing: '-0.1px',
          }}>
            {effectiveRepo
              ? `No ${filter === 'all' ? '' : filter + ' '}activity yet for ${shortRepoLabel(effectiveRepo)}.`
              : 'Attach a repo to see activity here.'}
          </div>
        ) : (
          grouped.map((group) => (
            <div key={group.label}>
              {/* Day label */}
              <div style={{
                paddingTop: 8,
                paddingRight: 14,
                paddingBottom: 4,
                paddingLeft: 14,
                fontSize: 9,
                fontWeight: 300,
                color: 'var(--t-text-faint)',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
              }}>
                {group.label}
              </div>

              {/* Items */}
              {group.items.map((item) => {
                if (item.kind === 'packet') {
                  const key = `pkt-${item.packet.id}`;
                  const isExpanded = expandedKey === key;
                  return (
                    <O8ActivityPacketRow
                      key={key}
                      packet={item.packet}
                      isExpanded={isExpanded}
                      onToggleExpanded={() => setExpandedKey(isExpanded ? null : key)}
                    />
                  );
                }
                const icon = feedIconForItem(item);
                const key = itemKey(item);
                const isExpanded = expandedKey === key;
                return (
                  <div key={key}>
                    <button
                      type="button"
                      aria-expanded={isExpanded}
                      onClick={() => {
                        if (isExpanded) {
                          setExpandedKey(null);
                        } else {
                          setExpandedKey(key);
                          fetchForItem(item, key);
                        }
                      }}
                      onDoubleClick={() => handleItemClick(item)}
                      title={item.kind === 'pr' ? 'Expand pull request' : 'Expand activity details'}
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 8,
                        width: '100%',
                        paddingTop: 7,
                        paddingRight: 14,
                        paddingBottom: 7,
                        paddingLeft: 14,
                        border: 'none',
                        background: isExpanded ? ACTIVITY_COLORS.accentBg : 'transparent',
                        cursor: 'pointer',
                        textAlign: 'left',
                        transition: 'background 100ms cubic-bezier(0.22, 1, 0.36, 1)',
                      }}
                      onMouseEnter={(e) => { if (!isExpanded) e.currentTarget.style.background = ACTIVITY_COLORS.accentBg; }}
                      onMouseLeave={(e) => { if (!isExpanded) e.currentTarget.style.background = 'transparent'; }}
                    >
                      {/* Expand indicator */}
                      <div style={{
                        width: 10, height: 20,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        flexShrink: 0, color: 'var(--t-text-faint)', fontSize: 10,
                        transition: 'transform 150ms cubic-bezier(0.22, 1, 0.36, 1)',
                        transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                      }}>
                        <svg width="7" height="7" viewBox="0 0 7 7" fill="currentColor"><path d="M1.5 0.5L5.5 3.5L1.5 6.5Z" /></svg>
                      </div>

                      {/* Status dot */}
                      <div style={{
                        width: 20, height: 20, borderRadius: '50%',
                        background: icon.bg,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        flexShrink: 0, marginTop: 1, color: icon.color,
                      }}>
                        {icon.icon}
                      </div>

                      {/* Content */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{
                          fontSize: 13.5, color: 'var(--t-text)',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          lineHeight: 1.25, fontWeight: 300, letterSpacing: '-0.1px',
                        }}>
                          {itemTitle(item)}
                        </div>
                        <div style={{
                          display: 'flex', alignItems: 'center', gap: 6,
                          marginTop: 3, fontSize: 9.5,
                          fontWeight: 260, letterSpacing: '-0.4px',
                          color: 'var(--t-text-faint)',
                          fontFamily: 'var(--font-sans-system)',
                          lineHeight: 1.25,
                        }}>
                          {itemSubline(item)}
                        </div>
                      </div>

                      {/* Trailing badge */}
                      {itemBadge(item)}
                    </button>

                    {/* Expanded detail */}
                    {isExpanded ? (
                      <div style={{
                        paddingTop: 6, paddingRight: 14, paddingBottom: 10, paddingLeft: 52,
                        borderBottom: '1px solid var(--t-panel-border, rgba(0,0,0,0.06))',
                      }}>
                        {renderExpandedDetail(item, prDetails, ciDetails, key, {
                          onOpenPr: (pr) => handleItemClick(pr),
                        })}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
});
