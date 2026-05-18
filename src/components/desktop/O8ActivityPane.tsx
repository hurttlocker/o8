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
import {
  ACTIVITY_COLORS,
  ALL_REPOS_KEY,
  EMPTY_DATA,
  FILTER_TABS,
  IconChevronDown,
  IconFolder,
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
import { DirectiveProposalRow } from './thoughts/DirectiveProposalRow';
import { useDirectiveProposals } from './thoughts/mission-panel/useDirectiveProposals';
import type { DirectiveProposalCandidate } from './thoughts/directive-proposal-types';
import type { RepoRegistryEntry } from '@/lib/repos/types';

const PROPOSALS_OPEN_KEY = 'o8:activity:proposals-open';

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
  repoSlug?: string | null;
  registeredRepos?: RepoRegistryEntry[];
  onSelectCommit?: (hash: string, meta?: Record<string, string>) => void;
  onSelectPR?: (prNumber: number, repo?: string) => void;
  onSelectIssue?: (issueNumber: number, repo?: string) => void;
}

export const O8ActivityPane = memo(function O8ActivityPane({
  repoSlug,
  registeredRepos: registeredRepoEntries = [],
  onSelectCommit,
  onSelectPR,
  onSelectIssue,
}: O8ActivityPaneProps) {
  const [data, setData] = useState<RepoActivityData>(EMPTY_DATA);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<O8FeedFilter>('all');
  const [fallbackRepoOptions, setFallbackRepoOptions] = useState<string[]>([]);
  const [repoOverride, setRepoOverride] = useState<string | null>(null);
  const [repoPickerOpen, setRepoPickerOpen] = useState(false);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [proposalsOpen, setProposalsOpen] = useState(false);

  // Hydrate the proposals open/closed pref after mount so SSR doesn't
  // hydrate-mismatch. Default = collapsed; the row is recommendations,
  // not pending tasks, so it shouldn't dominate the timeline visually.
  useEffect(() => {
    try {
      setProposalsOpen(window.localStorage.getItem(PROPOSALS_OPEN_KEY) === '1');
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

  const effectiveRepo = useMemo(() => {
    if (repoOverride && repoOverride !== ALL_REPOS_KEY) return repoOverride;
    const normalized = normalizeRepoSlug(repoSlug);
    if (normalized) return normalized;
    if (repoOptions.length > 0) return repoOptions[0];
    return null;
  }, [repoOverride, repoSlug, repoOptions]);

  const isAllRepos = repoOverride === ALL_REPOS_KEY;

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

  const repoLabel = isAllRepos ? 'All repos' : effectiveRepo ? shortRepoLabel(effectiveRepo) : 'No repo';

  const handleItemClick = useCallback((item: ActivityItem) => {
    if (item.kind === 'commit') {
      onSelectCommit?.(item.hash, item.repo ? { repo: item.repo } : undefined);
    } else if (item.kind === 'pr') {
      onSelectPR?.(item.number, item.repo);
    } else if (item.kind === 'issue') {
      if (onSelectIssue) {
        onSelectIssue(item.number, item.repo);
      } else {
        window.open(`https://github.com/${item.repo}/issues/${item.number}`, '_blank', 'noopener,noreferrer');
      }
    } else if (item.kind === 'ci') {
      window.open(`https://github.com/${item.repo}/actions/runs/${item.id}`, '_blank', 'noopener,noreferrer');
    }
  }, [onSelectCommit, onSelectPR, onSelectIssue]);

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
        <div style={{ position: 'relative', marginBottom: 8 }}>
          <button
            type="button"
            onClick={() => setRepoPickerOpen((v) => !v)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              minHeight: 28,
              paddingTop: 0,
              paddingRight: 10,
              paddingBottom: 0,
              paddingLeft: 8,
              borderRadius: 8,
              border: '0.5px solid var(--t-divider-subtle)',
              background: 'var(--t-panel)',
              cursor: 'pointer',
              fontFamily: 'var(--font-sans-system)',
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--t-text)',
              letterSpacing: '-0.01em',
            }}
          >
            <span style={{
              width: 18,
              height: 18,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 999,
              background: ACTIVITY_COLORS.accentBg,
              color: ACTIVITY_COLORS.accent,
            }}>
              <IconFolder size={11} color={ACTIVITY_COLORS.accent} />
            </span>
            {repoLabel}
            <IconChevronDown size={10} color="var(--t-text-muted)" />
          </button>

          {repoPickerOpen ? (
            <div className="cortex-scroll-fade-y cortex-themed-scroll" style={{
              position: 'absolute',
              top: 32,
              left: 0,
              right: 0,
              zIndex: 20,
              borderRadius: 12,
              border: '1px solid var(--t-panel-border)',
              background: 'var(--t-panel-solid)',
              boxShadow: 'var(--t-panel-shadow), 0 8px 24px rgba(15, 23, 42, 0.18)',
              maxHeight: 200,
              overflowY: 'auto',
            }}>
              <button
                type="button"
                onClick={() => { setRepoOverride(ALL_REPOS_KEY); setRepoPickerOpen(false); }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  paddingTop: 7,
                  paddingRight: 12,
                  paddingBottom: 7,
                  paddingLeft: 12,
                  border: 'none',
                  borderBottom: '1px solid var(--t-divider-subtle)',
                  background: isAllRepos ? ACTIVITY_COLORS.accentBg : 'transparent',
                  color: isAllRepos ? ACTIVITY_COLORS.accent : 'var(--t-text)',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: 'var(--font-sans-system)',
                  textAlign: 'left',
                }}
              >
                All repos
              </button>
              {repoOptions.map((slug) => {
                const selected = slug === effectiveRepo && !isAllRepos;
                return (
                  <button
                    key={slug}
                    type="button"
                    onClick={() => { setRepoOverride(slug); setRepoPickerOpen(false); }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      width: '100%',
                      paddingTop: 7,
                      paddingRight: 12,
                      paddingBottom: 7,
                      paddingLeft: 12,
                      border: 'none',
                      background: selected ? ACTIVITY_COLORS.accentBg : 'transparent',
                      color: selected ? ACTIVITY_COLORS.accent : 'var(--t-text)',
                      fontSize: 12,
                      fontWeight: selected ? 600 : 400,
                      cursor: 'pointer',
                      fontFamily: 'var(--font-sans-system)',
                      textAlign: 'left',
                    }}
                  >
                    <IconFolder size={12} color={selected ? ACTIVITY_COLORS.accent : 'var(--t-text-muted)'} />
                    {shortRepoLabel(slug)}
                    <span style={{
                      marginLeft: 'auto',
                      fontSize: 12,
                      color: 'var(--t-text-faint)',
                      fontFamily: 'var(--font-sans-system)',
                    }}>
                      {slug.split('/')[0]}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}
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
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: 'var(--font-sans-system)',
                  transition: 'all 120ms cubic-bezier(0.22, 1, 0.36, 1)',
                  letterSpacing: 0,
                }}
              >
                {tab.icon(active ? ACTIVITY_COLORS.accent : 'var(--t-text-muted)')}
                {tab.label}
                {count > 0 && tab.key !== 'all' ? (
                  <span style={{
                    fontSize: 11,
                    fontWeight: 600,
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
        {/* #746 — auto-directive proposals pin above the timeline so they
            read as recommendations (system → operator), distinct from the
            chronological feed. Collapsible (default closed) so the section
            doesn't visually dominate when several proposals are queued. */}
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
                background: proposalsOpen ? ACTIVITY_COLORS.attentionBg : 'transparent',
                cursor: 'pointer',
                textAlign: 'left',
                fontFamily: 'var(--font-sans-system)',
                transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1)',
              }}
              onMouseEnter={(e) => { if (!proposalsOpen) e.currentTarget.style.background = ACTIVITY_COLORS.attentionBg; }}
              onMouseLeave={(e) => { if (!proposalsOpen) e.currentTarget.style.background = 'transparent'; }}
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
                  color: 'var(--t-text-faint)',
                  transition: 'transform 150ms cubic-bezier(0.22, 1, 0.36, 1)',
                  transform: proposalsOpen ? 'rotate(90deg)' : 'rotate(0deg)',
                  flexShrink: 0,
                }}
              >
                <svg width="7" height="7" viewBox="0 0 7 7" fill="currentColor"><path d="M1.5 0.5L5.5 3.5L1.5 6.5Z" /></svg>
              </span>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  color: 'var(--t-text-muted)',
                  flex: 1,
                  minWidth: 0,
                }}
              >
                Proposed directives
              </span>
              <span
                title="Surfaced when the same fix-pattern appears 3+ times in the last 14 days"
                style={{
                  paddingTop: 1,
                  paddingRight: 6,
                  paddingBottom: 1,
                  paddingLeft: 6,
                  borderRadius: 999,
                  background: ACTIVITY_COLORS.attentionBg,
                  color: ACTIVITY_COLORS.attention,
                  fontSize: 11,
                  fontWeight: 600,
                  flexShrink: 0,
                }}
              >
                {proposals.length}
              </span>
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
            fontSize: 14,
            fontWeight: 400,
            color: 'var(--t-text-muted)',
            lineHeight: '19px',
            letterSpacing: 0,
          }}>
            Loading activity...
          </div>
        ) : filtered.length === 0 ? (
          <div style={{
            paddingTop: 32,
            paddingBottom: 32,
            textAlign: 'center',
            fontSize: 14,
            fontWeight: 400,
            color: 'var(--t-text-muted)',
            lineHeight: '19px',
            letterSpacing: 0,
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
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--t-text-faint)',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
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
                      onClick={() => {
                        if (item.kind === 'pr') {
                          handleItemClick(item);
                          return;
                        }
                        if (isExpanded) {
                          setExpandedKey(null);
                        } else {
                          setExpandedKey(key);
                          fetchForItem(item, key);
                        }
                      }}
                      onDoubleClick={() => handleItemClick(item)}
                      title={item.kind === 'pr' ? 'Open pull request details' : undefined}
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
                          fontSize: 14, color: 'var(--t-text)',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          lineHeight: '19px', fontWeight: 400,
                        }}>
                          {itemTitle(item)}
                        </div>
                        <div style={{
                          display: 'flex', alignItems: 'center', gap: 6,
                          marginTop: 1, fontSize: 12,
                          fontWeight: 400,
                          color: 'var(--t-text-muted)',
                          fontFamily: 'var(--font-sans-system)',
                          lineHeight: '16px',
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
                        {renderExpandedDetail(item, prDetails, ciDetails, key)}
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
