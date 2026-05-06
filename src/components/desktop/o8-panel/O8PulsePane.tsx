'use client';

/**
 * O8PulsePane - operator briefing surface for the wide O8 panel.
 *
 * Pulse intentionally uses the same sources as Activity, but it is not
 * another timeline. Activity owns the full chronological feed; Pulse gives
 * the operator the current temperature, focus queue, and latest movement.
 */

import { memo, useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import type { ActivityItem } from '@/components/desktop/agent-panel/types';
import { normalizeRepoSlug, relativeAge, repoSlugFromRemoteUrl, shortRepoLabel } from '@/components/desktop/agent-panel/shared';
import {
  feedIconForItem,
  fetchRepoActivity,
  itemKey,
  itemTitle,
  type RepoActivityData,
} from '@/components/desktop/o8-activity-helpers';
import { useOrchestratorData } from '@/components/desktop/orchestrator-data-context';
import { useTheme } from '@/lib/theme/context';
import { CodexIcon, ClaudeIcon, GeminiIcon, OpenCodeIcon } from '@/components/desktop/repo-registry/shared';
import { compactPacketLabel } from '@/lib/workspace-terminal/compact-packet-label';
import type { FleetAgent } from '@/components/desktop/thoughts/types';
import type { OrchestratorMissionState, OrchestratorRuntime } from '@/lib/orchestrator/types';

const UI_FONT = '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif';
const MONO = 'var(--font-mono, "SF Mono", Menlo, monospace)';
const MAX_REPOS = 6;

// Pulse panel surface tokens. The dark-palette set was the original — rgba
// whites that read as glass over dark vibrancy. Light mode needs the inverse:
// subtle dark washes over paper. Inline styles beat <style> tags so we
// can't fix this from CSS alone — the component picks the right block at
// render time based on the active palette.
const PULSE_VARS_DARK: CSSProperties = {
  ['--t-text' as string]: 'var(--t-chat-surface-text)',
  ['--t-text-secondary' as string]: 'var(--t-chat-surface-text-secondary)',
  ['--t-text-muted' as string]: 'var(--t-chat-surface-text-muted)',
  ['--t-text-faint' as string]: 'var(--t-chat-surface-text-muted)',
  ['--t-input-bg' as string]: 'var(--t-chat-surface-input-bg)',
  ['--t-bg-card' as string]: 'var(--t-chat-surface-card-bg)',
  ['--o8-pulse-surface' as string]: 'rgba(255, 255, 255, 0.035)',
  ['--o8-pulse-surface-strong' as string]: 'rgba(255, 255, 255, 0.055)',
  ['--o8-pulse-row' as string]: 'rgba(255, 255, 255, 0.045)',
  ['--o8-pulse-row-hover' as string]: 'rgba(255, 255, 255, 0.085)',
  ['--o8-pulse-inset' as string]: 'inset 0 1px 0 rgba(255, 255, 255, 0.055)',
  ['--o8-pulse-inset-strong' as string]: 'inset 0 1px 0 rgba(255, 255, 255, 0.09), 0 12px 30px rgba(0, 0, 0, 0.10)',
  ['--o8-pulse-muted' as string]: 'rgba(226, 232, 240, 0.52)',
  ['--o8-pulse-faint' as string]: 'rgba(226, 232, 240, 0.36)',
  ['--o8-pulse-hero-bg' as string]:
    'linear-gradient(135deg, rgba(255, 255, 255, 0.055) 0%, rgba(255, 255, 255, 0.025) 100%)',
};

const PULSE_VARS_LIGHT: CSSProperties = {
  ['--t-text' as string]: 'var(--t-chat-surface-text)',
  ['--t-text-secondary' as string]: 'var(--t-chat-surface-text-secondary)',
  ['--t-text-muted' as string]: 'var(--t-chat-surface-text-muted)',
  ['--t-text-faint' as string]: 'var(--t-chat-surface-text-muted)',
  ['--t-input-bg' as string]: 'var(--t-chat-surface-input-bg)',
  ['--t-bg-card' as string]: 'var(--t-chat-surface-card-bg)',
  ['--o8-pulse-surface' as string]: 'rgba(15, 23, 42, 0.04)',
  ['--o8-pulse-surface-strong' as string]: 'rgba(15, 23, 42, 0.06)',
  ['--o8-pulse-row' as string]: 'rgba(15, 23, 42, 0.035)',
  ['--o8-pulse-row-hover' as string]: 'rgba(15, 23, 42, 0.07)',
  ['--o8-pulse-inset' as string]: 'inset 0 1px 0 rgba(15, 23, 42, 0.05)',
  ['--o8-pulse-inset-strong' as string]: 'inset 0 1px 0 rgba(15, 23, 42, 0.08), 0 12px 30px rgba(15, 23, 42, 0.06)',
  ['--o8-pulse-muted' as string]: 'rgba(15, 23, 42, 0.62)',
  ['--o8-pulse-faint' as string]: 'rgba(15, 23, 42, 0.42)',
  ['--o8-pulse-hero-bg' as string]:
    'linear-gradient(135deg, rgba(15, 23, 42, 0.05) 0%, rgba(15, 23, 42, 0.025) 100%)',
};

const EMPTY_ACTIVITY: RepoActivityData = { commits: [], prs: [], issues: [], ciRuns: [] };
const EMPTY_AGENTS: FleetAgent[] = [];
const EMPTY_MISSION_STATE: OrchestratorMissionState = {
  version: 2,
  prompt: '',
  summary: '',
  packets: [],
  updatedAt: '',
};

const RUNTIME_LABEL: Record<OrchestratorRuntime, string> = {
  codex: 'Codex',
  gemini: 'Gemini',
  'claude-code': 'Claude',
  opencode: 'OpenCode',
};

const RUNTIME_COLOR: Record<OrchestratorRuntime, string> = {
  codex: '#7C3AED',
  gemini: '#2563EB',
  'claude-code': '#F97316',
  opencode: '#16A34A',
};

type SignalTone = 'neutral' | 'live' | 'attention' | 'danger' | 'success';
type CommitActivityItem = Extract<ActivityItem, { kind: 'commit' }>;
type PullRequestActivityItem = Extract<ActivityItem, { kind: 'pr' }>;
type IssueActivityItem = Extract<ActivityItem, { kind: 'issue' }>;
type CiActivityItem = Extract<ActivityItem, { kind: 'ci' }>;
type PacketActivityItem = Extract<ActivityItem, { kind: 'packet' }>;

interface RunningEntry {
  id: string;
  title: string;
  branch: string | null;
  runtime: OrchestratorRuntime;
  sessionKey?: string | null;
}

interface PulseStats {
  running: RunningEntry[];
  mixCounts: Record<OrchestratorRuntime, number>;
  totalRunning: number;
  dispatched: number;
  awaiting: number;
  mergedToday: number;
}

interface PulseBriefing {
  allItems: ActivityItem[];
  latest: ActivityItem[];
  focusQueue: ActivityItem[];
  commits: number;
  openPrs: number;
  prsNeedingReview: number;
  openIssues: number;
  failedCi: number;
  pendingCi: number;
}

interface O8PulsePaneProps {
  repoSlug?: string | null;
  onSelectCommit?: (hash: string, meta?: Record<string, string>) => void;
  onSelectPR?: (prNumber: number, repo?: string) => void;
  onSelectIssue?: (issueNumber: number, repo?: string) => void;
}

function isToday(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return false;
  const now = new Date();
  return date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
}

function isTsToday(ts: number): boolean {
  if (!Number.isFinite(ts)) return false;
  return isToday(new Date(ts).toISOString());
}

function normalizeRuntime(raw: string | null | undefined): OrchestratorRuntime {
  if (raw === 'claude-code' || raw === 'gemini' || raw === 'opencode') return raw;
  return 'codex';
}

function runtimeIcon(runtime: OrchestratorRuntime, size = 12) {
  if (runtime === 'claude-code') return <ClaudeIcon size={size} />;
  if (runtime === 'gemini') return <GeminiIcon size={size} />;
  if (runtime === 'opencode') return <OpenCodeIcon size={size} />;
  return <CodexIcon size={size} />;
}

function parseTs(value?: string | null): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function mergeActivityData(results: RepoActivityData[]): RepoActivityData {
  const merged: RepoActivityData = { commits: [], prs: [], issues: [], ciRuns: [] };
  for (const result of results) {
    merged.commits.push(...result.commits);
    merged.prs.push(...result.prs);
    merged.issues.push(...result.issues);
    merged.ciRuns.push(...result.ciRuns);
  }
  return merged;
}

function computePulse(missionState: OrchestratorMissionState, agents: FleetAgent[]): PulseStats {
  const packets = missionState.packets;

  const dispatched = packets.filter((packet) => packet.status !== 'draft' || Boolean(packet.lane)).length;
  const awaiting = packets.filter((packet) => packet.status === 'awaiting_review').length;
  const mergedToday = packets.filter((packet) => (
    (packet.releaseState === 'released' || packet.status === 'released')
    && isToday(packet.archivedAt ?? packet.review?.recordedAt ?? packet.lastEventAt)
  )).length;

  const runningKeys = new Set<string>();
  const running: RunningEntry[] = [];
  const mixCounts: Record<OrchestratorRuntime, number> = {
    codex: 0,
    gemini: 0,
    'claude-code': 0,
    opencode: 0,
  };

  for (const packet of packets) {
    if (packet.status !== 'running') continue;
    const key = packet.lane?.sessionKey ?? packet.id;
    if (runningKeys.has(key)) continue;
    runningKeys.add(key);
    const runtime = normalizeRuntime(packet.runtime);
    mixCounts[runtime] += 1;
    running.push({
      id: key,
      title: compactPacketLabel(packet.title) || packet.title,
      branch: packet.branchTarget || null,
      runtime,
      sessionKey: packet.lane?.sessionKey ?? null,
    });
  }

  for (const agent of agents) {
    if (agent.status !== 'running') continue;
    const key = agent.sessionKey ?? `${agent.runtime ?? 'codex'}:${agent.name ?? running.length}`;
    if (runningKeys.has(key)) continue;
    runningKeys.add(key);
    const runtime = normalizeRuntime(agent.runtime);
    mixCounts[runtime] += 1;
    const workspaceName = agent.workspace ? agent.workspace.split('/').pop() ?? null : null;
    running.push({
      id: key,
      title: agent.name ?? agent.sessionKey?.split(':').pop()?.slice(0, 14) ?? 'Agent',
      branch: workspaceName,
      runtime,
      sessionKey: agent.sessionKey ?? null,
    });
  }

  return {
    running,
    mixCounts,
    totalRunning: runningKeys.size,
    dispatched,
    awaiting,
    mergedToday,
  };
}

function buildPacketItems(missionState: OrchestratorMissionState): ActivityItem[] {
  return missionState.packets
    .filter((packet) => !packet.archivedAt)
    .filter((packet) => !(packet.comparisonGroupId && packet.comparisonIndex && packet.comparisonIndex > 0))
    .map((packet) => ({
      kind: 'packet' as const,
      packet,
      repo: packet.workspaceTargetPath ?? undefined,
      ts: parseTs(packet.lane?.lastEventAt) ?? parseTs(packet.lastEventAt) ?? Date.now(),
    }));
}

function buildBriefing(activity: RepoActivityData, packetItems: ActivityItem[]): PulseBriefing {
  const commits = activity.commits.filter((item): item is CommitActivityItem => item.kind === 'commit');
  const prs = activity.prs.filter((item): item is PullRequestActivityItem => item.kind === 'pr');
  const issues = activity.issues.filter((item): item is IssueActivityItem => item.kind === 'issue');
  const ciRuns = activity.ciRuns.filter((item): item is CiActivityItem => item.kind === 'ci');
  const packets = packetItems.filter((item): item is PacketActivityItem => item.kind === 'packet');
  const allItems = [
    ...commits,
    ...prs,
    ...issues,
    ...ciRuns,
    ...packets,
  ].sort((a, b) => b.ts - a.ts);

  const prsNeedingReview = prs.filter((item) => (
    item.state === 'open'
    && item.reviewDecision !== 'APPROVED'
  ));
  const failedCi = ciRuns.filter((item) => item.conclusion === 'failure');
  const pendingCi = ciRuns.filter((item) => !item.conclusion || item.status?.toLowerCase() !== 'completed');
  const openIssues = issues.filter((item) => item.state === 'open');
  const awaitingPackets = packets.filter((item) => item.packet.status === 'awaiting_review');

  const focusQueue = [
    ...awaitingPackets,
    ...failedCi,
    ...prsNeedingReview,
    ...openIssues,
  ].sort((a, b) => b.ts - a.ts).slice(0, 5);

  return {
    allItems,
    latest: allItems.slice(0, 7),
    focusQueue,
    commits: commits.filter((item) => isTsToday(item.ts)).length || commits.length,
    openPrs: prs.filter((item) => item.state === 'open').length,
    prsNeedingReview: prsNeedingReview.length,
    openIssues: openIssues.length,
    failedCi: failedCi.length,
    pendingCi: pendingCi.length,
  };
}

export const O8PulsePane = memo(function O8PulsePane({
  repoSlug,
  onSelectCommit,
  onSelectPR,
  onSelectIssue,
}: O8PulsePaneProps) {
  const data = useOrchestratorData();
  const [registeredRepos, setRegisteredRepos] = useState<string[]>([]);
  const [activity, setActivity] = useState<RepoActivityData>(EMPTY_ACTIVITY);
  const [loadingActivity, setLoadingActivity] = useState(true);
  const agents = data?.agents ?? EMPTY_AGENTS;
  const missionState: OrchestratorMissionState = data?.missionState ?? EMPTY_MISSION_STATE;

  const stats = useMemo(() => computePulse(missionState, agents), [missionState, agents]);
  const packetItems = useMemo(() => buildPacketItems(missionState), [missionState]);
  const normalizedRepoSlug = useMemo(() => normalizeRepoSlug(repoSlug), [repoSlug]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/panel/repos')
      .then((res) => res.json())
      .then((payload) => {
        if (cancelled) return;
        const slugs = ((payload.repos ?? []) as Array<{ remoteUrl?: string | null }>)
          .map((repo) => repoSlugFromRemoteUrl(repo.remoteUrl))
          .filter(Boolean) as string[];
        setRegisteredRepos(Array.from(new Set(slugs)));
      })
      .catch(() => {
        if (!cancelled) setRegisteredRepos([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const activityRepos = useMemo(() => {
    const slugs = registeredRepos.length > 0
      ? registeredRepos
      : normalizedRepoSlug
        ? [normalizedRepoSlug]
        : [];
    if (normalizedRepoSlug && !slugs.includes(normalizedRepoSlug)) {
      return [normalizedRepoSlug, ...slugs].slice(0, MAX_REPOS);
    }
    return slugs.slice(0, MAX_REPOS);
  }, [normalizedRepoSlug, registeredRepos]);

  const activityRepoKey = activityRepos.join('|');

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (activityRepos.length === 0) {
        setActivity(EMPTY_ACTIVITY);
        setLoadingActivity(false);
        return;
      }
      setLoadingActivity(true);
      try {
        const results = await Promise.all(
          activityRepos.map((slug) => fetchRepoActivity(slug).catch(() => EMPTY_ACTIVITY))
        );
        if (!cancelled) setActivity(mergeActivityData(results));
      } catch {
        if (!cancelled) setActivity(EMPTY_ACTIVITY);
      } finally {
        if (!cancelled) setLoadingActivity(false);
      }
    }

    void load();

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
  }, [activityRepoKey, activityRepos]);

  const briefing = useMemo(() => buildBriefing(activity, packetItems), [activity, packetItems]);
  const scopeLabel = activityRepos.length > 1
    ? `${activityRepos.length} repos`
    : activityRepos[0]
      ? shortRepoLabel(activityRepos[0])
      : 'Local fleet';

  const openActivity = useCallback(() => {
    data?.onOpenO8Panel?.({ tab: 'activity' });
  }, [data]);

  const handleItemOpen = useCallback((item: ActivityItem) => {
    if (item.kind === 'commit') {
      if (onSelectCommit) {
        onSelectCommit(item.hash, item.repo ? { repo: item.repo } : undefined);
      } else if (item.repo) {
        window.open(`https://github.com/${item.repo}/commit/${item.hash}`, '_blank', 'noopener,noreferrer');
      }
      return;
    }
    if (item.kind === 'pr') {
      if (onSelectPR) {
        onSelectPR(item.number, item.repo);
      } else {
        window.open(`https://github.com/${item.repo}/pull/${item.number}`, '_blank', 'noopener,noreferrer');
      }
      return;
    }
    if (item.kind === 'issue') {
      if (onSelectIssue) {
        onSelectIssue(item.number, item.repo);
      } else {
        window.open(`https://github.com/${item.repo}/issues/${item.number}`, '_blank', 'noopener,noreferrer');
      }
      return;
    }
    if (item.kind === 'ci') {
      window.open(`https://github.com/${item.repo}/actions/runs/${item.id}`, '_blank', 'noopener,noreferrer');
      return;
    }
    if (item.kind === 'packet') {
      if (item.packet.lane?.sessionKey) {
        data?.onSelectSession?.(item.packet.lane.sessionKey);
      } else {
        data?.onSelectedPacketChange?.(item.packet.id);
      }
      data?.onOpenO8Panel?.({ repoPath: item.packet.workspaceTargetPath, tab: 'activity' });
    }
  }, [data, onSelectCommit, onSelectIssue, onSelectPR]);

  const totalAttention = stats.awaiting + briefing.prsNeedingReview + briefing.failedCi + briefing.openIssues;

  const { paletteId } = useTheme();
  const pulseVars = paletteId === 'light' ? PULSE_VARS_LIGHT : PULSE_VARS_DARK;

  return (
    <div
      className="o8-pulse-pane"
      style={{
        ...pulseVars,
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        background: 'transparent',
        color: 'var(--t-chat-surface-text)',
        fontFamily: UI_FONT,
        paddingTop: 14,
        paddingRight: 14,
        paddingBottom: 16,
        paddingLeft: 14,
        gap: 14,
      }}
    >
      <PulseHero
        activityCount={briefing.allItems.length}
        loading={loadingActivity}
        onOpenActivity={openActivity}
        running={stats.totalRunning}
        scopeLabel={scopeLabel}
        totalAttention={totalAttention}
      />
      <SignalGrid
        failedCi={briefing.failedCi}
        mergedToday={stats.mergedToday}
        openPrs={briefing.openPrs}
        pendingCi={briefing.pendingCi}
        running={stats.totalRunning}
        reviewCount={stats.awaiting + briefing.prsNeedingReview}
      />
      <NowSection running={stats.running} onSelectSession={data?.onSelectSession} />
      <MixBar mixCounts={stats.mixCounts} totalRunning={stats.totalRunning} />
      <ActivityDigest
        emptyLabel={loadingActivity ? 'Pulling activity...' : 'No attention items right now.'}
        items={briefing.focusQueue}
        label="[FOCUS]"
        onOpenItem={handleItemOpen}
        tone="attention"
      />
      <ActivityDigest
        emptyLabel={loadingActivity ? 'Pulling activity...' : 'No recent activity surfaced yet.'}
        items={briefing.latest}
        label="[LATEST]"
        onOpenItem={handleItemOpen}
        tone="neutral"
      />
      <style>{`
        html[data-palette='light'] .o8-pulse-pane {
          --o8-pulse-hero-text: #F4F2ED;
        }
        @keyframes o8-pulse {
          0% { box-shadow: 0 0 0 0 rgba(249, 115, 22, 0.28); }
          70% { box-shadow: 0 0 0 7px rgba(249, 115, 22, 0); }
          100% { box-shadow: 0 0 0 0 rgba(249, 115, 22, 0); }
        }
      `}</style>
    </div>
  );
});

function PulseHero({
  activityCount,
  loading,
  onOpenActivity,
  running,
  scopeLabel,
  totalAttention,
}: {
  activityCount: number;
  loading: boolean;
  onOpenActivity: () => void;
  running: number;
  scopeLabel: string;
  totalAttention: number;
}) {
  const live = running > 0;
  const stateLabel = live
    ? 'Fleet active'
    : totalAttention > 0
      ? 'Needs attention'
      : 'Fleet quiet';

  return (
    <section
      style={{
        ...surfaceStyle,
        paddingTop: 16,
        paddingRight: 16,
        paddingBottom: 16,
        paddingLeft: 16,
        background: 'var(--o8-pulse-hero-bg)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <span
          style={{
            width: 11,
            height: 11,
            borderRadius: '50%',
            background: live ? '#16a34a' : totalAttention > 0 ? '#f97316' : 'var(--t-text-muted)',
            boxShadow: live ? '0 0 0 3px rgba(22, 163, 74, 0.16)' : totalAttention > 0 ? '0 0 0 3px rgba(249, 115, 22, 0.12)' : 'none',
            animation: live ? 'o8-pulse 1.8s cubic-bezier(0.22, 1, 0.36, 1) infinite' : 'none',
            marginTop: 7,
            flexShrink: 0,
          }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <SectionLabel>[PULSE]</SectionLabel>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, marginTop: 6, minWidth: 0 }}>
            <span style={{ fontSize: 28, fontWeight: 760, lineHeight: 1, color: 'var(--o8-pulse-hero-text, var(--t-text))', fontFeatureSettings: '"tnum"' }}>
              {running}
            </span>
            <span style={{ fontSize: 14, fontWeight: 760, color: 'var(--o8-pulse-hero-text, var(--t-text))' }}>
              {stateLabel}
            </span>
          </div>
          <div style={{ marginTop: 6, color: 'var(--o8-pulse-muted)', fontSize: 11.5, lineHeight: '17px' }}>
            {loading ? 'Reading activity...' : `${scopeLabel} watched · ${activityCount} recent signals`}
          </div>
        </div>
        <button
          type="button"
          onClick={onOpenActivity}
          style={{
            minHeight: 30,
            borderRadius: 10,
            borderWidth: 0,
            background: 'var(--o8-pulse-row)',
            boxShadow: 'var(--o8-pulse-inset)',
            color: 'var(--o8-pulse-muted)',
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            paddingTop: 0,
            paddingRight: 10,
            paddingBottom: 0,
            paddingLeft: 10,
            fontFamily: UI_FONT,
            fontSize: 11,
            fontWeight: 760,
            flexShrink: 0,
          }}
        >
          Activity
        </button>
      </div>
    </section>
  );
}

function SignalGrid({
  failedCi,
  mergedToday,
  openPrs,
  pendingCi,
  reviewCount,
  running,
}: {
  failedCi: number;
  mergedToday: number;
  openPrs: number;
  pendingCi: number;
  reviewCount: number;
  running: number;
}) {
  const packetReviews = Math.max(0, reviewCount - openPrs);
  const reviewMeta = packetReviews > 0
    ? `${openPrs} PR${openPrs === 1 ? '' : 's'} · ${packetReviews} packet${packetReviews === 1 ? '' : 's'}`
    : openPrs === 1
      ? 'PR open'
      : `${openPrs} PRs open`;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
      <SignalCard label="Running" meta={running > 0 ? 'live work' : 'idle'} tone={running > 0 ? 'live' : 'neutral'} value={running} />
      <SignalCard label="Review" meta={reviewMeta} tone={reviewCount > 0 ? 'attention' : 'success'} value={reviewCount} />
      <SignalCard
        label="CI risk"
        meta={failedCi > 0 ? `${pendingCi} pending` : pendingCi > 0 ? 'checks pending' : `${mergedToday} merged today`}
        tone={failedCi > 0 ? 'danger' : pendingCi > 0 ? 'attention' : 'success'}
        value={failedCi}
      />
    </div>
  );
}

function SignalCard({ label, meta, tone, value }: { label: string; meta: string; tone: SignalTone; value: number }) {
  const color = toneColor(tone);
  return (
    <div style={{ ...surfaceStyle, paddingTop: 12, paddingRight: 12, paddingBottom: 12, paddingLeft: 12, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ color: 'var(--o8-pulse-muted)', fontSize: 10, fontWeight: 760, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          {label}
        </span>
        <span style={{ width: 7, height: 7, borderRadius: 999, background: color, boxShadow: `0 0 0 3px ${color}1c`, flexShrink: 0 }} />
      </div>
      <div style={{ marginTop: 8, fontSize: 23, fontWeight: 760, lineHeight: 1, color, fontFeatureSettings: '"tnum"' }}>
        {value}
      </div>
      <div style={{ marginTop: 5, color: 'var(--o8-pulse-muted)', fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {meta}
      </div>
    </div>
  );
}

function NowSection({ running, onSelectSession }: { running: RunningEntry[]; onSelectSession?: (sessionKey: string) => void }) {
  return (
    <section style={{ ...surfaceStyle, paddingTop: 12, paddingRight: 12, paddingBottom: 12, paddingLeft: 12 }}>
      <SectionHeader label="[NOW]" detail={running.length > 0 ? `${running.length} live` : 'idle'} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
        {running.length === 0 ? (
          <EmptyLine>No agents running.</EmptyLine>
        ) : (
          running.slice(0, 5).map((entry) => (
            <NowRow key={entry.id} entry={entry} onSelectSession={onSelectSession} />
          ))
        )}
      </div>
    </section>
  );
}

function NowRow({ entry, onSelectSession }: { entry: RunningEntry; onSelectSession?: (sessionKey: string) => void }) {
  const clickable = Boolean(entry.sessionKey && onSelectSession);
  const content = (
    <>
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: RUNTIME_COLOR[entry.runtime],
          boxShadow: `0 0 0 3px ${RUNTIME_COLOR[entry.runtime]}18`,
          flexShrink: 0,
        }}
      />
      <span style={{ display: 'inline-flex', flexShrink: 0 }}>{runtimeIcon(entry.runtime)}</span>
      <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 680, color: 'var(--t-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {entry.title}
      </span>
      {entry.branch ? <InlinePill>{entry.branch}</InlinePill> : null}
    </>
  );

  if (clickable) {
    return (
      <button type="button" onClick={() => onSelectSession?.(entry.sessionKey!)} style={rowButtonStyle}>
        {content}
      </button>
    );
  }

  return <div style={rowStaticStyle}>{content}</div>;
}

function MixBar({ mixCounts, totalRunning }: { mixCounts: Record<OrchestratorRuntime, number>; totalRunning: number }) {
  const order: OrchestratorRuntime[] = ['codex', 'gemini', 'claude-code', 'opencode'];
  const visible = order.filter((runtime) => mixCounts[runtime] > 0);

  return (
    <section style={{ ...surfaceStyle, paddingTop: 12, paddingRight: 12, paddingBottom: 12, paddingLeft: 12 }}>
      <SectionHeader label="[MIX]" detail={totalRunning > 0 ? 'runtime distribution' : 'no live mix'} />
      {totalRunning === 0 ? (
        <div style={{ marginTop: 10 }}><EmptyLine>Runtime mix appears once agents are active.</EmptyLine></div>
      ) : (
        <>
          <div style={{ display: 'flex', height: 7, borderRadius: 999, overflow: 'hidden', background: 'var(--o8-pulse-row)', marginTop: 12 }}>
            {visible.map((runtime) => (
              <div
                key={runtime}
                title={`${RUNTIME_LABEL[runtime]} ${mixCounts[runtime]}`}
                style={{ width: `${(mixCounts[runtime] / totalRunning) * 100}%`, background: RUNTIME_COLOR[runtime] }}
              />
            ))}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 10 }}>
            {visible.map((runtime) => (
              <span key={runtime} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--o8-pulse-muted)', fontFamily: MONO, fontSize: 10.5 }}>
                <span style={{ width: 6, height: 6, borderRadius: 2, background: RUNTIME_COLOR[runtime] }} />
                {RUNTIME_LABEL[runtime]} {mixCounts[runtime]}
              </span>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function ActivityDigest({
  emptyLabel,
  items,
  label,
  onOpenItem,
  tone,
}: {
  emptyLabel: string;
  items: ActivityItem[];
  label: string;
  onOpenItem: (item: ActivityItem) => void;
  tone: 'attention' | 'neutral';
}) {
  return (
    <section style={{ ...surfaceStyle, paddingTop: 12, paddingRight: 12, paddingBottom: 12, paddingLeft: 12 }}>
      <SectionHeader label={label} detail={items.length > 0 ? `${items.length} signal${items.length === 1 ? '' : 's'}` : 'clear'} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
        {items.length === 0 ? (
          <EmptyLine>{emptyLabel}</EmptyLine>
        ) : (
          items.map((item) => (
            <DigestRow key={`${tone}-${itemKey(item)}`} item={item} onOpen={() => onOpenItem(item)} tone={tone} />
          ))
        )}
      </div>
    </section>
  );
}

function DigestRow({ item, onOpen, tone }: { item: ActivityItem; onOpen: () => void; tone: 'attention' | 'neutral' }) {
  const icon = digestIcon(item);
  return (
    <button
      type="button"
      onClick={onOpen}
      style={rowButtonStyle}
      onMouseEnter={(event) => {
        event.currentTarget.style.background = 'var(--o8-pulse-row-hover)';
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = 'var(--o8-pulse-row)';
      }}
    >
      <span
        style={{
          width: 24,
          height: 24,
          borderRadius: 9,
          background: 'var(--o8-pulse-surface-strong)',
          color: icon.color,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        {icon.icon}
      </span>
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 12, fontWeight: 680, color: 'var(--t-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {itemTitle(item)}
        </span>
        <span style={{ fontFamily: MONO, color: 'var(--o8-pulse-muted)', fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {digestMeta(item)}
        </span>
      </span>
      {tone === 'attention' ? <AttentionPill item={item} /> : null}
    </button>
  );
}

function digestIcon(item: ActivityItem): { bg: string; color: string; icon: ReactNode } {
  if (item.kind === 'packet') {
    const runtime = normalizeRuntime(item.packet.runtime);
    return {
      bg: `${RUNTIME_COLOR[runtime]}14`,
      color: RUNTIME_COLOR[runtime],
      icon: runtimeIcon(runtime, 13),
    };
  }
  return feedIconForItem(item);
}

function digestMeta(item: ActivityItem): string {
  if (item.kind === 'commit') return `${item.repo ? shortRepoLabel(item.repo) : 'local'} · ${item.hash.slice(0, 7)} · ${item.age}`;
  if (item.kind === 'pr') return `${shortRepoLabel(item.repo)} · ${item.branch || 'branch'} · ${item.age}`;
  if (item.kind === 'issue') return `${shortRepoLabel(item.repo)} · ${item.comments} comments · ${item.age}`;
  if (item.kind === 'ci') return `${shortRepoLabel(item.repo)} · ${item.workflow || 'CI'} · ${item.conclusion || item.status}`;
  if (item.kind === 'packet') {
    const ageSource = item.packet.lane?.lastEventAt ?? item.packet.lastEventAt ?? null;
    return `${item.packet.status.replaceAll('_', ' ')} · ${ageSource ? relativeAge(ageSource) : 'recent'}`;
  }
  return 'Recent activity';
}

function AttentionPill({ item }: { item: ActivityItem }) {
  const label = attentionLabel(item);
  if (!label) return null;
  return <InlinePill tone={label.tone}>{label.text}</InlinePill>;
}

function attentionLabel(item: ActivityItem): { text: string; tone: SignalTone } | null {
  if (item.kind === 'ci') return { text: item.conclusion === 'failure' ? 'CI' : 'check', tone: item.conclusion === 'failure' ? 'danger' : 'attention' };
  if (item.kind === 'pr') return { text: item.reviewDecision === 'CHANGES_REQUESTED' ? 'changes' : 'review', tone: 'attention' };
  if (item.kind === 'issue') return { text: 'issue', tone: 'neutral' };
  if (item.kind === 'packet') return { text: item.packet.status.replaceAll('_', ' '), tone: 'attention' };
  return null;
}

function SectionHeader({ label, detail }: { label: string; detail: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
      <SectionLabel>{label}</SectionLabel>
      <span style={{ color: 'var(--o8-pulse-muted)', fontSize: 10.5, fontWeight: 680 }}>{detail}</span>
    </div>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div style={{ fontFamily: MONO, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.10em', color: 'var(--o8-pulse-muted)', textTransform: 'uppercase' }}>
      {children}
    </div>
  );
}

function InlinePill({ children, tone = 'neutral' }: { children: ReactNode; tone?: SignalTone }) {
  const color = toneColor(tone);
  return (
    <span
      style={{
        maxWidth: 132,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        flexShrink: 0,
        fontFamily: MONO,
        fontSize: 10,
        fontWeight: 680,
        color,
        background: 'var(--o8-pulse-surface)',
        borderWidth: 0,
        boxShadow: `inset 0 0 0 1px ${color}22`,
        borderRadius: 999,
        paddingTop: 2,
        paddingRight: 7,
        paddingBottom: 2,
        paddingLeft: 7,
      }}
    >
      {children}
    </span>
  );
}

function EmptyLine({ children }: { children: ReactNode }) {
  return (
    <div style={{ color: 'var(--o8-pulse-muted)', fontSize: 11.5, lineHeight: '17px', paddingTop: 3, paddingBottom: 3 }}>
      {children}
    </div>
  );
}

function toneColor(tone: SignalTone): string {
  if (tone === 'live' || tone === 'success') return '#16a34a';
  if (tone === 'attention') return '#f97316';
  if (tone === 'danger') return '#ef4444';
  return '#94a3b8';
}

const surfaceStyle: CSSProperties = {
  borderRadius: 18,
  borderWidth: 0,
  background: 'var(--o8-pulse-surface)',
  boxShadow: 'var(--o8-pulse-inset)',
};

const rowBaseStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  minWidth: 0,
  minHeight: 36,
  borderRadius: 12,
  borderWidth: 0,
  background: 'var(--o8-pulse-row)',
  boxShadow: 'var(--o8-pulse-inset)',
  paddingTop: 7,
  paddingRight: 8,
  paddingBottom: 7,
  paddingLeft: 8,
  fontFamily: UI_FONT,
};

const rowButtonStyle: CSSProperties = {
  ...rowBaseStyle,
  cursor: 'pointer',
  textAlign: 'left',
};

const rowStaticStyle: CSSProperties = {
  ...rowBaseStyle,
};
