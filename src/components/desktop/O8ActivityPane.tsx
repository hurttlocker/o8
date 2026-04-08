'use client';

/**
 * O8ActivityPane — Activity feed for the O8 Panel right-side panel.
 *
 * Fetches commits, PRs, issues, and CI runs from the panel API endpoints.
 * Renders a unified, chronological timeline with segmented filter pills
 * and a repo selector dropdown.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ActivityItem } from './agent-panel/types';
import { shortRepoLabel, normalizeRepoSlug } from './agent-panel/shared';
import {
  ALL_REPOS_KEY,
  EMPTY_DATA,
  FILTER_TABS,
  IconChevronDown,
  IconFolder,
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

// ── Component ──

interface O8ActivityPaneProps {
  repoSlug?: string | null;
  onSelectCommit?: (hash: string, meta?: Record<string, string>) => void;
  onSelectPR?: (prNumber: number, repo?: string) => void;
  onSelectIssue?: (issueNumber: number, repo?: string) => void;
}

export const O8ActivityPane = memo(function O8ActivityPane({
  repoSlug,
  onSelectCommit,
  onSelectPR,
  onSelectIssue,
}: O8ActivityPaneProps) {
  const [data, setData] = useState<RepoActivityData>(EMPTY_DATA);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<O8FeedFilter>('all');
  const [registeredRepos, setRegisteredRepos] = useState<string[]>([]);
  const [repoOverride, setRepoOverride] = useState<string | null>(null);
  const [repoPickerOpen, setRepoPickerOpen] = useState(false);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const { prDetails, ciDetails, fetchForItem } = useExpandDetails();
  const mountedRef = useRef(true);

  // Fetch registered repos
  useEffect(() => {
    fetch('/api/panel/repos')
      .then((res) => res.json())
      .then((d) => {
        const slugs = (d.repos ?? [])
          .map((r: { remoteUrl?: string }) => {
            const url = (r.remoteUrl ?? '').replace(/\.git$/, '');
            const parts = url.split('/');
            return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : null;
          })
          .filter(Boolean) as string[];
        if (mountedRef.current) setRegisteredRepos(slugs);
      })
      .catch(() => {});
    return () => { mountedRef.current = false; };
  }, []);

  const effectiveRepo = useMemo(() => {
    if (repoOverride && repoOverride !== ALL_REPOS_KEY) return repoOverride;
    const normalized = normalizeRepoSlug(repoSlug);
    if (normalized) return normalized;
    if (registeredRepos.length > 0) return registeredRepos[0];
    return null;
  }, [repoOverride, repoSlug, registeredRepos]);

  const isAllRepos = repoOverride === ALL_REPOS_KEY;

  // Fetch activity data
  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        if (isAllRepos) {
          const results = await Promise.all(
            registeredRepos.map((slug) => fetchRepoActivity(slug).catch(() => EMPTY_DATA))
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
  }, [effectiveRepo, isAllRepos, registeredRepos]);

  // Build sorted timeline
  const allItems = useMemo<ActivityItem[]>(() => {
    const timeline = [...data.commits, ...data.prs, ...data.issues, ...data.ciRuns];
    timeline.sort((a, b) => b.ts - a.ts);
    return timeline.slice(0, 50);
  }, [data]);

  const counts = useMemo(() => {
    const c: Record<O8FeedFilter, number> = { all: allItems.length, commit: 0, issue: 0, pr: 0, ci: 0 };
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
              fontFamily: '-apple-system, system-ui, sans-serif',
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
              background: 'rgba(37, 99, 235, 0.12)',
              color: '#2563eb',
            }}>
              <IconFolder size={11} color="#2563eb" />
            </span>
            {repoLabel}
            <IconChevronDown size={10} color="var(--t-text-muted)" />
          </button>

          {repoPickerOpen ? (
            <div style={{
              position: 'absolute',
              top: 32,
              left: 0,
              right: 0,
              zIndex: 20,
              borderRadius: 12,
              border: '1px solid var(--t-divider)',
              background: 'var(--t-chrome, #1e2028)',
              boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
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
                  background: isAllRepos ? 'rgba(37,99,235,0.12)' : 'transparent',
                  color: isAllRepos ? '#2563eb' : 'var(--t-text)',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: '-apple-system, system-ui, sans-serif',
                  textAlign: 'left',
                }}
              >
                All repos
              </button>
              {registeredRepos.map((slug) => {
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
                      background: selected ? 'rgba(37,99,235,0.12)' : 'transparent',
                      color: selected ? '#2563eb' : 'var(--t-text)',
                      fontSize: 12,
                      fontWeight: selected ? 600 : 400,
                      cursor: 'pointer',
                      fontFamily: '-apple-system, system-ui, sans-serif',
                      textAlign: 'left',
                    }}
                  >
                    <IconFolder size={12} color={selected ? '#2563eb' : 'var(--t-text-muted)'} />
                    {shortRepoLabel(slug)}
                    <span style={{
                      marginLeft: 'auto',
                      fontSize: 9,
                      color: 'var(--t-text-faint)',
                      fontFamily: '"SF Mono", ui-monospace, monospace',
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
          {FILTER_TABS.map((tab) => {
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
                  background: active ? 'rgba(37, 99, 235, 0.12)' : 'transparent',
                  color: active ? '#2563eb' : 'var(--t-text-muted)',
                  fontSize: 10,
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: '-apple-system, system-ui, sans-serif',
                  transition: 'all 120ms ease',
                  letterSpacing: '-0.01em',
                }}
              >
                {tab.icon(active ? '#2563eb' : 'var(--t-text-muted)')}
                {tab.label}
                {count > 0 && tab.key !== 'all' ? (
                  <span style={{
                    fontSize: 9,
                    fontWeight: 700,
                    color: active ? '#2563eb' : 'var(--t-text-faint)',
                    fontFamily: '"SF Mono", ui-monospace, monospace',
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
      <div style={{
        flex: 1,
        overflowY: 'auto',
        overflowX: 'hidden',
      }}>
        {loading ? (
          <div style={{
            paddingTop: 32,
            paddingBottom: 32,
            textAlign: 'center',
            fontSize: 11,
            color: 'var(--t-text-muted)',
            letterSpacing: '-0.01em',
          }}>
            Loading activity...
          </div>
        ) : filtered.length === 0 ? (
          <div style={{
            paddingTop: 32,
            paddingBottom: 32,
            textAlign: 'center',
            fontSize: 11,
            color: 'var(--t-text-muted)',
            lineHeight: 1.5,
            letterSpacing: '-0.01em',
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
                fontSize: 10,
                fontWeight: 700,
                color: 'var(--t-text-faint)',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
              }}>
                {group.label}
              </div>

              {/* Items */}
              {group.items.map((item) => {
                const icon = feedIconForItem(item);
                const key = itemKey(item);
                const isExpanded = expandedKey === key;
                return (
                  <div key={key}>
                    <button
                      type="button"
                      onClick={() => {
                        if (isExpanded) {
                          setExpandedKey(null);
                        } else {
                          setExpandedKey(key);
                          fetchForItem(item, key);
                        }
                      }}
                      onDoubleClick={() => handleItemClick(item)}
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
                        background: isExpanded ? 'rgba(37,99,235,0.06)' : 'transparent',
                        cursor: 'pointer',
                        textAlign: 'left',
                        transition: 'background 100ms ease',
                      }}
                      onMouseEnter={(e) => { if (!isExpanded) e.currentTarget.style.background = 'rgba(37,99,235,0.04)'; }}
                      onMouseLeave={(e) => { if (!isExpanded) e.currentTarget.style.background = 'transparent'; }}
                    >
                      {/* Expand indicator */}
                      <div style={{
                        width: 10, height: 20,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        flexShrink: 0, color: 'var(--t-text-faint)', fontSize: 10,
                        transition: 'transform 150ms ease',
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
                          fontSize: 12, color: 'var(--t-text)',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          lineHeight: 1.4, fontWeight: 500,
                        }}>
                          {itemTitle(item)}
                        </div>
                        <div style={{
                          display: 'flex', alignItems: 'center', gap: 6,
                          marginTop: 1, fontSize: 10,
                          color: 'var(--t-text-muted)',
                          fontFamily: '"SF Mono", ui-monospace, monospace',
                          lineHeight: 1.4,
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
