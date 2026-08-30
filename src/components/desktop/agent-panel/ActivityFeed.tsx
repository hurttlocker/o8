'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityFeedControls } from './ActivityFeedControls';
import { ActivityFeedTimeline } from './ActivityFeedTimeline';
import {
  ActivityFeedEmptyState,
  activityItemKey,
  agentRepoSlug,
  normalizeActivitySubject,
  normalizeRepoSlug,
  relativeAge,
  shortRepoLabel,
  shortWorkspaceLabel,
} from './shared';
import type {
  ActivityItem,
  AgentDetail,
  CIHoverDetail,
  CommitSummary,
  EventEntry,
  FeedFilter,
  PRHoverDetail,
  RepoTaskLaunchRequest,
} from './types';
import { ipcFetch } from '@/lib/tauri/ipc-fetch';

const ALL_REPOS_KEY = '__github__';

interface ActivityFeedProps {
  events: EventEntry[];
  commits: CommitSummary[];
  agents: AgentDetail[];
  onSelectSession?: (sessionKey: string) => void;
  onSelectIssue?: (issueNumber: number, repo?: string) => void;
  onSelectCommit?: (hash: string, meta?: Record<string, string>) => void;
  onSelectPR?: (prNumber: number, repo?: string) => void;
  onReviewPR?: (prNumber: number, repo?: string) => void;
  onLaunchTask?: (request: RepoTaskLaunchRequest) => void;
  activeRepo?: string | null;
  activeAgentKey?: string | null;
  refreshKey?: number;
}

type ActivityExtras = {
  issues: ActivityItem[];
  prs: ActivityItem[];
  ciRuns: ActivityItem[];
  repoCommits: ActivityItem[];
};

const EMPTY_EXTRAS: ActivityExtras = { issues: [], prs: [], ciRuns: [], repoCommits: [] };

export const ActivityFeed = memo(function ActivityFeed({
  events,
  commits,
  agents,
  onSelectSession,
  onSelectIssue,
  onSelectCommit,
  onSelectPR,
  onReviewPR,
  onLaunchTask,
  activeRepo: externalRepo,
  activeAgentKey,
  refreshKey,
}: ActivityFeedProps) {
  const [extras, setExtras] = useState<ActivityExtras>(EMPTY_EXTRAS);
  const [remoteScopeError, setRemoteScopeError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FeedFilter>('all');
  const [repoOverrideState, setRepoOverrideState] = useState<{
    activeAgentKey: string | null;
    value: string | null;
  }>(() => ({ activeAgentKey: activeAgentKey ?? null, value: null }));
  const repoOverride = repoOverrideState.activeAgentKey === (activeAgentKey ?? null)
    ? repoOverrideState.value
    : null;
  const setRepoOverride = useCallback((value: string | null) => {
    setRepoOverrideState({ activeAgentKey: activeAgentKey ?? null, value });
  }, [activeAgentKey]);
  const [repoPickerOpen, setRepoPickerOpen] = useState(false);
  const [registeredRepos, setRegisteredRepos] = useState<string[]>([]);
  const [hoveredItemKey, setHoveredItemKey] = useState<string | null>(null);
  const [hoveredItemRect, setHoveredItemRect] = useState<DOMRect | null>(null);
  const hoverCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [prHoverDetails, setPrHoverDetails] = useState<Record<string, PRHoverDetail>>({});
  const [ciHoverDetails, setCiHoverDetails] = useState<Record<string, CIHoverDetail>>({});
  const [timelineOrigin, setTimelineOrigin] = useState(Date.now);

  useEffect(() => {
    ipcFetch('/api/panel/repos')
      .then((response) => response.json())
      .then((data) => {
        const ghRepos = (data.repos ?? [])
          .map((repo: { remoteUrl?: string }) => {
            const url = (repo.remoteUrl ?? '').replace(/\.git$/, '');
            const parts = url.split('/');
            return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : null;
          })
          .filter(Boolean) as string[];
        setRegisteredRepos(ghRepos);
      })
      .catch(() => {});
  }, []);

  const activeAgent = useMemo(
    () => agents.find((agent) => agent.sessionKey === activeAgentKey) ?? null,
    [agents, activeAgentKey],
  );
  const activeAgentRepo = useMemo(() => agentRepoSlug(activeAgent), [activeAgent]);
  const activeAgentWorkspaceLabel = useMemo(
    () => shortWorkspaceLabel(activeAgent?.runtimeSurface?.cwd ?? activeAgent?.workspace),
    [activeAgent],
  );
  const externalPanelRepo = useMemo(() => normalizeRepoSlug(externalRepo), [externalRepo]);
  const liveAgentRepos = useMemo(
    () => agents
      .map((agent) => agentRepoSlug(agent))
      .filter((repo): repo is string => Boolean(repo)),
    [agents],
  );

  const allRepos = useMemo(() => {
    const repoSet = new Set<string>();
    if (activeAgentRepo) repoSet.add(activeAgentRepo);
    if (externalPanelRepo) repoSet.add(externalPanelRepo);
    for (const repo of liveAgentRepos) repoSet.add(repo);
    for (const repo of registeredRepos) {
      const normalized = normalizeRepoSlug(repo);
      if (normalized) repoSet.add(normalized);
    }
    return Array.from(repoSet);
  }, [activeAgentRepo, externalPanelRepo, liveAgentRepos, registeredRepos]);

  const repo = useMemo(() => {
    if (repoOverride) return repoOverride;
    if (externalPanelRepo) return externalPanelRepo;
    if (activeAgentRepo) return activeAgentRepo;
    if (allRepos.length > 0) return ALL_REPOS_KEY;
    return null;
  }, [repoOverride, activeAgentRepo, externalPanelRepo, allRepos]);

  const isAllRepos = repo === ALL_REPOS_KEY;
  const repoLabel = isAllRepos ? 'GitHub' : repo ? shortRepoLabel(repo) : activeAgentWorkspaceLabel;
  const scopeHelp = isAllRepos
    ? 'Recent pull requests, commits, issues, and checks across your registered repos.'
    : repo
      ? `Recent pull requests, commits, issues, and checks for ${shortRepoLabel(repo)}.`
      : 'Recent repo work appears here once a GitHub repo is attached.';

  const agentRepoById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agentRepoSlug(agent)])),
    [agents],
  );
  const visibleAgentEvents = useMemo(() => {
    return events.filter((event) => {
      const eventRepo = agentRepoById.get(event.agentId) ?? event.repo ?? null;
      if (!eventRepo) return !repo || isAllRepos;
      if (!repo || isAllRepos) return true;
      return eventRepo === repo;
    });
  }, [agentRepoById, events, isAllRepos, repo]);

  const rateLimitPausedUntilRef = useRef<number>(0);
  useEffect(() => {
    async function fetchForRepo(repoSlug: string) {
      if (Date.now() < rateLimitPausedUntilRef.current) {
        return { issues: [], prs: [], ciRuns: [], commits: [], errors: ['GitHub rate limit — paused until reset'] };
      }

      const [issuesRes, prsRes, ciRes, commitsRes] = await Promise.all([
        fetch(`/api/panel/issues?repo=${encodeURIComponent(repoSlug)}`).catch(() => null),
        fetch(`/api/panel/prs?repo=${encodeURIComponent(repoSlug)}`).catch(() => null),
        fetch(`/api/panel/ci?repo=${encodeURIComponent(repoSlug)}`).catch(() => null),
        ipcFetch(`/api/panel/commits?repo=${encodeURIComponent(repoSlug)}`).catch(() => null),
      ]);

      for (const response of [issuesRes, prsRes, ciRes, commitsRes]) {
        if (!response) continue;
        if (response.status === 403 || response.status === 429) {
          const retryAfter = response.headers.get('retry-after');
          const resetHeader = response.headers.get('x-ratelimit-reset');
          const pauseMs = retryAfter
            ? Number(retryAfter) * 1000
            : resetHeader
              ? Math.max((Number(resetHeader) * 1000) - Date.now(), 60_000)
              : 5 * 60_000;
          rateLimitPausedUntilRef.current = Date.now() + pauseMs;
          break;
        }
      }

      const repoName = repoSlug.split('/').pop() ?? repoSlug;
      const errors: string[] = [];
      const issueItems: ActivityItem[] = [];
      if (issuesRes?.ok) {
        const data = await issuesRes.json();
        if (data.error) errors.push(String(data.error));
        for (const issue of (data.issues ?? []).slice(0, 8)) {
          const ts = issue.createdAt ? new Date(issue.createdAt).getTime() : 0;
          issueItems.push({
            kind: 'issue',
            number: issue.number,
            title: issue.title,
            state: (issue.state ?? '').toLowerCase(),
            labels: issue.labels ?? [],
            age: issue.createdAt ? relativeAge(issue.createdAt) : '',
            ts,
            repo: repoSlug,
            author: issue.author?.login ?? 'unknown',
            assignees: (issue.assignees ?? [])
              .map((assignee: { login?: string | null }) => assignee.login ?? '')
              .filter(Boolean),
            comments: typeof issue.comments === 'number' ? issue.comments : 0,
            body: (issue.body ?? '').trim(),
          });
        }
      }

      const prItems: ActivityItem[] = [];
      if (prsRes?.ok) {
        const data = await prsRes.json();
        if (data.error) errors.push(String(data.error));
        for (const pr of (data.prs ?? []).slice(0, 8)) {
          const ts = pr.createdAt ? new Date(pr.createdAt).getTime() : 0;
          const checks = pr.statusCheckRollup ?? [];
          prItems.push({
            kind: 'pr',
            number: pr.number,
            title: pr.title,
            state: (pr.state ?? '').toLowerCase(),
            author: pr.author?.login ?? '',
            branch: pr.headRefName ?? '',
            additions: pr.additions ?? 0,
            deletions: pr.deletions ?? 0,
            changedFiles: pr.changedFiles ?? 0,
            reviewDecision: pr.reviewDecision ?? '',
            checkSummary: {
              passed: checks.filter((check: { conclusion?: string | null }) => check.conclusion?.toLowerCase() === 'success').length,
              failed: checks.filter((check: { conclusion?: string | null }) => check.conclusion?.toLowerCase() === 'failure').length,
              pending: checks.filter((check: { conclusion?: string | null; status?: string | null }) => !check.conclusion || check.status?.toLowerCase() !== 'completed').length,
            },
            failingChecks: checks
              .filter((check: { name?: string | null; conclusion?: string | null }) => check.conclusion?.toLowerCase() === 'failure')
              .map((check: { name?: string | null }) => check.name || 'Unknown check')
              .slice(0, 3),
            age: pr.createdAt ? relativeAge(pr.createdAt) : '',
            ts,
            repo: repoSlug,
          });
        }
      }

      const ciItems: ActivityItem[] = [];
      if (ciRes?.ok) {
        const data = await ciRes.json();
        if (data.error) errors.push(String(data.error));
        for (const run of (data.runs ?? []).slice(0, 6)) {
          const ts = run.createdAt ? new Date(run.createdAt).getTime() : 0;
          ciItems.push({
            kind: 'ci',
            id: run.databaseId,
            title: run.displayTitle ?? '',
            status: run.status ?? '',
            conclusion: run.conclusion ?? '',
            branch: run.headBranch ?? '',
            workflow: run.workflowName ?? '',
            age: run.createdAt ? relativeAge(run.createdAt) : '',
            ts,
            repo: repoSlug,
          });
        }
      }

      const commitItems: ActivityItem[] = [];
      if (commitsRes?.ok) {
        const data = await commitsRes.json();
        if (data.error) errors.push(String(data.error));
        for (const commit of (data.commits ?? []).slice(0, 10)) {
          const ts = commit.date ? new Date(commit.date).getTime() : 0;
          commitItems.push({
            kind: 'commit',
            hash: commit.hash ?? '',
            message: `${isAllRepos ? `[${repoName}] ` : ''}${commit.message ?? ''}`,
            age: commit.date ? relativeAge(commit.date) : '',
            ts,
            repo: repoSlug,
          });
        }
      }

      return { issues: issueItems, prs: prItems, ciRuns: ciItems, commits: commitItems, errors };
    }

    async function fetchExtras() {
      try {
        if (!repo) {
          setExtras(EMPTY_EXTRAS);
          setRemoteScopeError(null);
          return;
        }

        if (isAllRepos) {
          if (allRepos.length === 0) {
            setExtras(EMPTY_EXTRAS);
            setRemoteScopeError(null);
            return;
          }

          const results = await Promise.all(allRepos.map((repoSlug) => fetchForRepo(repoSlug).catch((error) => ({
            issues: [],
            prs: [],
            ciRuns: [],
            commits: [],
            errors: [error instanceof Error ? error.message : 'Unable to load repo activity'],
          }))));

          const merged: ActivityExtras = { issues: [], prs: [], ciRuns: [], repoCommits: [] };
          const mergedErrors: string[] = [];
          for (const result of results) {
            merged.issues.push(...result.issues);
            merged.prs.push(...result.prs);
            merged.ciRuns.push(...result.ciRuns);
            merged.repoCommits.push(...result.commits);
            mergedErrors.push(...result.errors);
          }
          setTimelineOrigin(Date.now());
          setExtras(merged);
          setRemoteScopeError(mergedErrors.length > 0 ? Array.from(new Set(mergedErrors)).join(' | ') : null);
          return;
        }

        const result = await fetchForRepo(repo);
        setTimelineOrigin(Date.now());
        setExtras({ issues: result.issues, prs: result.prs, ciRuns: result.ciRuns, repoCommits: result.commits });
        setRemoteScopeError(result.errors.length > 0 ? result.errors.join(' | ') : null);
      } catch {
        setRemoteScopeError(null);
      }
    }

    void fetchExtras();
    // WS-driven: refresh on agent/lane events instead of 5min-only polling
    const handler = () => {
      setTimelineOrigin(Date.now());
      void fetchExtras();
    };
    const wsEvents = ['o8:lifecycle-reconcile'];
    for (const e of wsEvents) window.addEventListener(e, handler);
    const fallbackId = setInterval(handler, 300_000);
    return () => {
      clearInterval(fallbackId);
      for (const e of wsEvents) window.removeEventListener(e, handler);
    };
  }, [allRepos, isAllRepos, refreshKey, repo]);

  const fallbackCommitItems = useMemo<ActivityItem[]>(() => {
    if (repo || extras.repoCommits.length > 0) return [];
    const fallbackRepo = externalPanelRepo ?? activeAgentRepo ?? null;
    return commits.slice(0, 10).map((commit, index) => ({
      kind: 'commit' as const,
      hash: commit.hash,
      message: commit.message,
      age: commit.age,
      ts: timelineOrigin - index,
      repo: fallbackRepo ?? undefined,
    }));
  }, [activeAgentRepo, commits, externalPanelRepo, extras.repoCommits.length, repo, timelineOrigin]);

  const items = useMemo<ActivityItem[]>(() => {
    const timeline: ActivityItem[] = [];
    timeline.push(...extras.repoCommits, ...fallbackCommitItems);
    if (!repo || isAllRepos) {
      for (const event of visibleAgentEvents) {
        const ts = event.timestamp ? new Date(event.timestamp).getTime() || timelineOrigin : timelineOrigin;
        timeline.push({ kind: 'event', data: event, ts });
      }
    }
    timeline.push(...extras.issues, ...extras.prs, ...extras.ciRuns);
    timeline.sort((a, b) => b.ts - a.ts);
    return timeline.slice(0, 40);
  }, [extras, fallbackCommitItems, isAllRepos, repo, timelineOrigin, visibleAgentEvents]);

  const counts = useMemo(() => {
    const nextCounts: Record<FeedFilter, number> = { all: items.length, commit: 0, issue: 0, pr: 0, ci: 0, packet: 0 };
    for (const item of items) {
      if (item.kind === 'event') continue;
      if (item.kind in nextCounts) nextCounts[item.kind as FeedFilter]++;
    }
    return nextCounts;
  }, [items]);

  const filtered = useMemo(() => {
    if (filter !== 'all') return items.filter((item) => item.kind === filter);

    const primarySubjects = new Set(
      items.flatMap((item) => {
        if (item.kind === 'commit') {
          const subject = normalizeActivitySubject(item.message);
          return subject ? [subject] : [];
        }
        if (item.kind === 'pr') {
          const subject = normalizeActivitySubject(item.title);
          return subject ? [subject] : [];
        }
        return [];
      }),
    );

    return items.filter((item) => {
      if (item.kind !== 'ci') return true;
      const subject = normalizeActivitySubject(item.title);
      return !(subject && primarySubjects.has(subject));
    });
  }, [filter, items]);

  const commitStack = useMemo(
    () => extras.repoCommits.filter((item): item is Extract<ActivityItem, { kind: 'commit' }> => item.kind === 'commit').slice(0, 5),
    [extras.repoCommits],
  );

  const openHoverCard = useCallback((key: string, rect: DOMRect) => {
    if (hoverCloseTimerRef.current) {
      clearTimeout(hoverCloseTimerRef.current);
      hoverCloseTimerRef.current = null;
    }
    setHoveredItemKey(key);
    setHoveredItemRect(rect);
  }, []);

  const scheduleHoverClose = useCallback(() => {
    if (hoverCloseTimerRef.current) clearTimeout(hoverCloseTimerRef.current);
    hoverCloseTimerRef.current = setTimeout(() => {
      setHoveredItemKey(null);
      setHoveredItemRect(null);
    }, 140);
  }, []);

  const cancelHoverClose = useCallback(() => {
    if (hoverCloseTimerRef.current) {
      clearTimeout(hoverCloseTimerRef.current);
      hoverCloseTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!hoveredItemKey) return;
    const hoveredItem = items.find((item) => activityItemKey(item) === hoveredItemKey);
    if (!hoveredItem) return;

    if (hoveredItem.kind === 'pr' && !prHoverDetails[hoveredItemKey]) {
      fetch(`/api/panel/pr?repo=${encodeURIComponent(hoveredItem.repo)}&number=${hoveredItem.number}`)
        .then((response) => response.json())
        .then((detail) => {
          if (detail?.error) return;
          setPrHoverDetails((current) => ({
            ...current,
            [hoveredItemKey]: {
              mergeable: Boolean(detail.mergeable),
              checksStatus: detail.checksStatus ?? 'unknown',
              reviewDecision: detail.reviewDecision ?? null,
              files: detail.files ?? [],
            },
          }));
        })
        .catch(() => {});
    }

    if (hoveredItem.kind === 'ci' && !ciHoverDetails[hoveredItemKey]) {
      fetch(`/api/panel/ci/${hoveredItem.id}?repo=${encodeURIComponent(hoveredItem.repo)}`)
        .then((response) => response.json())
        .then((detail) => {
          if (detail?.error) return;
          const jobs = detail.run?.jobs ?? [];
          const failingJobs = jobs
            .filter((job: { conclusion?: string | null }) => job.conclusion?.toLowerCase() === 'failure')
            .map((job: { name: string; steps?: Array<{ name?: string | null; conclusion?: string | null }> }) => ({
              name: job.name,
              failingStep: job.steps?.find((step) => step.conclusion?.toLowerCase() === 'failure')?.name ?? null,
            }))
            .slice(0, 3);
          const summaryLine = String(detail.logs ?? '')
            .split('\n')
            .find((line) => line.includes('##[error]') || line.toLowerCase().includes('error ts') || line.toLowerCase().includes('failed'))
            ?.replace(/^.*##\[error\]/, '')
            .trim() ?? null;
          setCiHoverDetails((current) => ({
            ...current,
            [hoveredItemKey]: { failingJobs, summaryLine },
          }));
        })
        .catch(() => {});
    }
  }, [ciHoverDetails, hoveredItemKey, items, prHoverDetails]);

  const grouped = useMemo(() => {
    const groups: Array<{ label: string; items: ActivityItem[] }> = [];
    let currentLabel = '';
    const today = new Date(timelineOrigin).toDateString();
    const yesterday = new Date(timelineOrigin - 86400000).toDateString();

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
  }, [filtered, timelineOrigin]);

  const missingGitHubScope = allRepos.length === 0 && !externalPanelRepo && !activeAgentRepo;
  const openPrItems = extras.prs.filter((item): item is Extract<ActivityItem, { kind: 'pr' }> => item.kind === 'pr' && item.state === 'open');
  const openPrContext = openPrItems.length > 0 ? { count: openPrItems.length, repo: openPrItems[0].repo } : null;

  if (!items.length) {
    return <ActivityFeedEmptyState missingGitHubScope={missingGitHubScope} repoLabel={repoLabel} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <ActivityFeedControls
        repoLabel={repoLabel}
        repoPickerOpen={repoPickerOpen}
        onToggleRepoPicker={() => setRepoPickerOpen((current) => !current)}
        isAllRepos={isAllRepos}
        repo={repo}
        allRepos={allRepos}
        scopeHelp={scopeHelp}
        remoteScopeError={remoteScopeError}
        filter={filter}
        counts={counts}
        onSelectFilter={setFilter}
        onSelectRepo={(repoSlug) => {
          setRepoOverride(repoSlug);
          setRepoPickerOpen(false);
        }}
        onSelectAllRepos={() => {
          setRepoOverride(ALL_REPOS_KEY);
          setRepoPickerOpen(false);
        }}
        openPrContext={openPrContext}
        onOpenPrs={(repoSlug) => (onReviewPR ?? onSelectPR)?.(0, repoSlug)}
      />

      <ActivityFeedTimeline
        grouped={grouped}
        filteredLength={filtered.length}
        filter={filter}
        repoLabel={repoLabel}
        items={items}
        agents={agents}
        hoveredItemKey={hoveredItemKey}
        hoveredItemRect={hoveredItemRect}
        prHoverDetails={prHoverDetails}
        ciHoverDetails={ciHoverDetails}
        commitStack={commitStack}
        onOpenHoverCard={openHoverCard}
        onUpdateHoveredRect={setHoveredItemRect}
        onScheduleHoverClose={scheduleHoverClose}
        onCancelHoverClose={cancelHoverClose}
        onSelectSession={onSelectSession}
        onSelectIssue={onSelectIssue}
        onSelectCommit={onSelectCommit}
        onSelectPR={onSelectPR}
        onReviewPR={onReviewPR}
        onLaunchTask={onLaunchTask}
      />
    </div>
  );
});
