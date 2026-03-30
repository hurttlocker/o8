'use client';
/* eslint-disable @typescript-eslint/no-unused-vars, react-hooks/exhaustive-deps, react-hooks/set-state-in-effect, @next/next/no-img-element -- canvas viewers are legacy inspector surfaces pending deeper cleanup */

/**
 * Canvas — Bottom-half contextual workspace with tabs.
 *
 * Responds to selections from AgentPanel:
 *   - Issue selected → opens issue detail tab
 *   - Agent surface clicked → opens live transcript tab
 *   - File selected → opens file viewer tab
 *
 * Tabs persist — you can have multiple open and switch between them.
 * Each tab type renders its own content viewer.
 *
 * Q's spec: bottom half of center, tabbed, replaces modals for primary content.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Clipboard,
  ExternalLink,
  RefreshCw,
  FileEdit,
  FileMinus,
  FilePlus,
  FileText,
  GitCommit,
  GitPullRequest,
  GitMerge,
  Globe,
  Hexagon,
  MessageSquare,
  Play,
  Plus,
  Radio,
  RotateCcw,
  Send,
  Terminal,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import { MarkdownBody } from './MarkdownBody';
import { IssueCreator } from './IssueCreator';
// GraphExplorer3D lazy-loaded — only needed for 'memory' tab kind
import { lazy, Suspense } from 'react';
const LazyGraphExplorer3D = lazy(() => import('./GraphExplorer3D').then(m => ({ default: m.GraphExplorer3D })));
import dynamic from 'next/dynamic';
import { loader } from '@monaco-editor/react';

const MonacoEditor = dynamic(() => import('@/lib/monaco-polyfills').then(() =>
  import('@monaco-editor/react').then((mod) => mod.default)
), {
  ssr: false,
  loading: () => <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: 'var(--t-text-muted)' }}>Loading editor…</div>,
});
const MonacoDiffEditor = dynamic(() => import('@/lib/monaco-polyfills').then(() =>
  import('@monaco-editor/react').then((mod) => mod.DiffEditor)
), {
  ssr: false,
  loading: () => <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: 'var(--t-text-muted)' }}>Loading diff…</div>,
});
import {
  formatCiCheckBatchInjection,
  formatCiCheckInjection,
  formatReviewCommentBatchInjection,
  formatReviewCommentInjection,
  type AgentPanelChatInjectionPayload,
} from '@/lib/chat/injection';
import { useTheme } from '@/lib/theme/context';
import type { AgentSummary } from '@/lib/fleet/types';
import type { MobileInboxSnapshot } from '@/lib/mobile/types';
import type { RepoReadiness, RepoRegistryEntry } from '@/lib/repos/types';
import { deriveWorkflowStage, describeWorkflowStage, type WorkflowStageBadge } from '@/lib/workflows/status';

export type CanvasRepoTaskLaunchRequest =
  | { kind: 'issue'; repo: string; number: number; title: string; body?: string }
  | { kind: 'pr'; repo: string; number: number; title: string; branch?: string };

// ── Tab Types ──

export type CanvasTabKind = 'issue' | 'transcript' | 'file' | 'diff' | 'commit' | 'pr' | 'readme' | 'ci' | 'new-issue' | 'git-log' | 'image' | 'deploy' | 'memory' | 'welcome' | 'timeline' | 'mermaid' | 'preview';

export interface CanvasTab {
  id: string;
  kind: CanvasTabKind;
  label: string;
  /** Issue number, session key, file path, etc. */
  resourceId: string;
  /** Optional metadata (e.g., repo for scoped issue/PR queries) */
  meta?: Record<string, string>;
}

export interface CanvasProps {
  tabs: CanvasTab[];
  activeTabId: string | null;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  selectedRepo?: string | null;
  onSelectCommit?: (hash: string, meta?: Record<string, string>) => void;
  onInjectChatContext?: (payload: AgentPanelChatInjectionPayload) => void;
  onLaunchWorkspaceTask?: (request: CanvasRepoTaskLaunchRequest) => Promise<void>;
  /** When embedded in ContextualPanel, hide the tab bar (parent manages tabs) */
  embedded?: boolean;
}

const THEME_ACCENT = 'var(--t-accent, #2563eb)';
const THEME_ACCENT_SOFT = 'var(--t-accent-soft, rgba(37, 99, 235, 0.08))';
const THEME_ACCENT_BORDER = 'var(--t-accent-border, rgba(37, 99, 235, 0.22))';
const REPLAY_CARD_BACKGROUND = 'linear-gradient(180deg, var(--t-panel-translucent) 0%, var(--t-bg-card, rgba(148, 163, 184, 0.08)) 100%)';

function sessionReplayRuntimePalette(runtime?: string) {
  switch (runtime) {
    case 'Codex':
      return {
        color: '#4ade80',
        background: 'rgba(34, 197, 94, 0.12)',
        border: 'rgba(34, 197, 94, 0.18)',
      };
    default:
      return {
        color: 'var(--t-text-secondary)',
        background: 'var(--t-divider-subtle)',
        border: 'var(--t-panel-border)',
      };
  }
}

function repoSlugFromRemote(remoteUrl: string | null | undefined) {
  if (!remoteUrl) return null;
  const match = remoteUrl.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/i);
  return match?.[1] ?? null;
}

function readinessTone(readiness?: RepoReadiness | null) {
  switch (readiness?.state) {
    case 'ready':
      return { background: 'rgba(34,197,94,0.08)', border: 'rgba(34,197,94,0.16)', color: '#15803d' };
    case 'needs_setup':
      return { background: 'rgba(245,158,11,0.10)', border: 'rgba(245,158,11,0.18)', color: '#b45309' };
    case 'blocked':
      return { background: 'rgba(239,68,68,0.10)', border: 'rgba(239,68,68,0.18)', color: '#b91c1c' };
    default:
      return { background: 'rgba(148,163,184,0.12)', border: 'rgba(148,163,184,0.2)', color: '#475569' };
  }
}

// ── Main Canvas ──

export const Canvas = memo(function Canvas({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  selectedRepo,
  onSelectCommit,
  onInjectChatContext,
  onLaunchWorkspaceTask,
  embedded,
}: CanvasProps) {
  const activeTab = tabs.find((t) => t.id === activeTabId) || null;
  const tabScrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const syncScrollState = useCallback(() => {
    const el = tabScrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 2);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
  }, []);

  const scrollTabs = useCallback((direction: 'left' | 'right') => {
    const el = tabScrollRef.current;
    if (!el) return;
    el.scrollBy({ left: direction === 'left' ? -160 : 160, behavior: 'smooth' });
  }, []);
  // Check overflow after tabs change (deferred to avoid layout thrash)
  useEffect(() => {
    const raf = requestAnimationFrame(syncScrollState);
    return () => cancelAnimationFrame(raf);
  }, [tabs.length, syncScrollState]);

  if (tabs.length === 0) {
    return <CanvasEmpty />;
  }

  return (
    <div style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      background: 'var(--t-bg-subtle)',
      borderTop: '1px solid var(--t-divider)',
    }}>
      {/* Tab bar — hidden when embedded in ContextualPanel */}
      {!embedded && <div style={{
        position: 'relative',
        height: 36,
        flexShrink: 0,
        background: 'var(--t-panel-translucent)',
        backdropFilter: 'blur(20px) saturate(1.6)',
        WebkitBackdropFilter: 'blur(20px) saturate(1.6)',
        borderBottom: '1px solid var(--t-divider)',
      }}>
        {/* Scroll left arrow */}
        {canScrollLeft && (
          <div
            onClick={() => scrollTabs('left')}
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 0,
              width: 28,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'linear-gradient(to right, var(--t-panel-translucent) 60%, transparent)',
              zIndex: 2,
              cursor: 'pointer',
              color: 'var(--t-text-secondary)',
              transition: 'opacity 150ms ease',
            }}
          >
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
          </div>
        )}
        {/* Scroll right arrow */}
        {canScrollRight && (
          <div
            onClick={() => scrollTabs('right')}
            style={{
              position: 'absolute',
              right: 0,
              top: 0,
              bottom: 0,
              width: 28,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'linear-gradient(to left, var(--t-panel-translucent) 60%, transparent)',
              zIndex: 2,
              cursor: 'pointer',
              color: 'var(--t-text-secondary)',
              transition: 'opacity 150ms ease',
            }}
          >
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6"/></svg>
          </div>
        )}
        <div
          ref={tabScrollRef}
          onScroll={syncScrollState}
          onMouseEnter={syncScrollState}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 0,
            height: '100%',
            paddingLeft: 8,
            paddingRight: 8,
            overflowX: 'auto',
            overflowY: 'hidden',
            scrollbarWidth: 'none',
          }}
        >
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              onClick={() => onSelectTab(tab.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                height: 28,
                padding: '0 10px',
                marginRight: 2,
                borderRadius: 8,
                fontSize: 12,
                fontWeight: isActive ? 600 : 400,
                color: isActive ? 'var(--t-text)' : 'var(--t-text-secondary)',
                background: isActive ? 'var(--t-panel)' : 'transparent',
                boxShadow: isActive
                  ? 'var(--t-panel-shadow)'
                  : 'none',
                cursor: 'pointer',
                transition: 'all 150ms ease',
                flexShrink: 0,
                letterSpacing: '-0.01em',
                userSelect: 'none',
              }}
            >
              <TabIcon kind={tab.kind} size={13} />
              <span style={{
                maxWidth: 140,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {tab.label}
              </span>
              <div
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(tab.id);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 16,
                  height: 16,
                  borderRadius: 4,
                  marginLeft: 2,
                  color: 'var(--t-text-muted)',
                  cursor: 'pointer',
                  transition: 'all 100ms ease',
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLDivElement).style.background = 'var(--t-divider)';
                  (e.currentTarget as HTMLDivElement).style.color = '#ef4444';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLDivElement).style.background = 'transparent';
                  (e.currentTarget as HTMLDivElement).style.color = 'var(--t-text-muted)';
                }}
              >
                <X size={11} />
              </div>
            </div>
          );
        })}
        </div>
      </div>}

      {/* Tab content */}
      <div style={{
        flex: 1,
        overflow: 'hidden',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
      }}>
        {activeTab ? (
          <TabContent
            tab={activeTab}
            selectedRepo={selectedRepo}
            onSelectCommit={onSelectCommit}
            onInjectChatContext={onInjectChatContext}
            onLaunchWorkspaceTask={onLaunchWorkspaceTask}
          />
        ) : (
          <CanvasEmpty />
        )}
      </div>
    </div>
  );
});

// ── Tab Icon ──

function TabIcon({ kind, size = 14 }: { kind: CanvasTabKind; size?: number }) {
  switch (kind) {
    case 'issue': return <AlertCircle size={size} />;
    case 'transcript': return <Terminal size={size} />;
    case 'file': return <FileText size={size} />;
    case 'diff': return <GitCommit size={size} />;
    case 'commit': return <GitCommit size={size} />;
    case 'pr': return <GitCommit size={size} />;
    case 'readme': return <BookOpen size={size} />;
    case 'ci': return <AlertCircle size={size} />;
    case 'new-issue': return <Plus size={size} />;
    case 'git-log': return <GitCommit size={size} />;
    case 'image': return <FileText size={size} />;
    case 'deploy': return <Globe size={size} />;
    case 'memory': return <Radio size={size} />;
    case 'welcome': return <BookOpen size={size} />;
    case 'timeline': return <Clock size={size} />;
    case 'mermaid': return <Hexagon size={size} />;
    case 'preview': return <Globe size={size} />;
  }
}

// ── Tab Content Router ──

const TabContent = memo(function TabContent({
  tab,
  selectedRepo,
  onSelectCommit,
  onInjectChatContext,
  onLaunchWorkspaceTask,
}: {
  tab: CanvasTab;
  selectedRepo?: string | null;
  onSelectCommit?: (hash: string, meta?: Record<string, string>) => void;
  onInjectChatContext?: (payload: AgentPanelChatInjectionPayload) => void;
  onLaunchWorkspaceTask?: (request: CanvasRepoTaskLaunchRequest) => Promise<void>;
}) {
  switch (tab.kind) {
    case 'issue':
      return (
        <IssueViewer
          issueNumber={parseInt(tab.resourceId, 10)}
          repo={tab.meta?.repo ?? selectedRepo ?? undefined}
          onLaunchWorkspaceTask={onLaunchWorkspaceTask}
        />
      );
    case 'transcript':
      return <TranscriptViewer sessionKey={tab.resourceId} />;
    case 'file':
      return <FileViewer filePath={tab.resourceId} workspace={tab.meta?.workspace} />;
    case 'diff':
      return <DiffViewer />;
    case 'commit':
      return <CommitViewer commitHash={tab.resourceId} workspace={tab.meta?.workspace} />;
    case 'pr':
      return <PRViewer prNumber={parseInt(tab.resourceId, 10)} repo={tab.meta?.repo} onInjectChatContext={onInjectChatContext} />;
    case 'readme':
      return <ReadmeViewer workspace={tab.resourceId} />;
    case 'ci':
      return <CIViewer repo={tab.meta?.repo} initialRunId={tab.meta?.selectedRun ? parseInt(tab.meta.selectedRun, 10) : undefined} />;
    case 'new-issue':
      return <IssueCreator repo={tab.meta?.repo} />;
    case 'git-log':
      return <GitLogViewer workspace={tab.resourceId} onSelectCommit={onSelectCommit} />;
    case 'image':
      return <ImagePreview filePath={tab.resourceId} workspace={tab.meta?.workspace} />;
    case 'deploy':
      return <DeployViewer project={tab.meta?.project} />;
    case 'memory':
      return <Suspense fallback={null}><LazyGraphExplorer3D /></Suspense>;
    case 'welcome':
      return <CanvasEmpty />;
    case 'timeline':
      return <TimelineExpanded />;
    case 'mermaid':
      return <MermaidViewer code={tab.resourceId} />;
    case 'preview':
      return <PortPreview url={tab.resourceId} port={parseInt(tab.meta?.port ?? '0', 10)} repo={tab.meta?.repo} />;
    default:
      return <CanvasEmpty />;
  }
});

// ── Timeline Expanded View ──

type ReplaySegment = {
  kind: string;
  startMin: number;
  durationMin: number;
  label?: string;
  agent?: string;
};

function timelineReplayDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function timelineReplayTime(minutesSinceAnchor: number): string {
  const h = 6 + Math.floor(minutesSinceAnchor / 60);
  const m = minutesSinceAnchor % 60;
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h > 12 ? h - 12 : h === 0 ? 12 : h;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

function timelineReplayRuntimeLabel(runtime: string | null | undefined): string {
  if (runtime === 'claude-code') return 'Claude Code';
  if (runtime === 'codex') return 'Codex';
  return runtime || 'Runtime';
}

function timelineReplayWorkspace(path: string | null | undefined): string | null {
  if (!path || path === 'unknown') return null;
  const normalized = path.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length <= 4) return normalized;
  return `~/${parts.slice(-4).join('/')}`;
}

function timelineReplayTask(task: string | null | undefined): string | null {
  if (!task) return null;
  return task
    .replace(/^IDE-owned Codex session ready for the next input via resume\.?\s*/i, '')
    .replace(/^Live Codex terminal verified via pid\/log mapping on s\d+\.\s*/i, '')
    .replace(/^Live Codex terminal detected on s\d+\.\s*/i, '')
    .replace(/^Recent automation surface; useful for visibility, not the primary operator lane\.?\s*/i, '')
    .replace(/^Mirroring the live Q ↔ Mister conversation, not spawning a fresh session\.?\s*/i, '')
    .trim();
}

function timelineReplayMatchesAgent(agentName: string, session: AgentSummary): boolean {
  const key = session.sessionKey.toLowerCase();
  const name = (session.name || '').toLowerCase();
  if (agentName === 'codex') return session.runtime === 'codex';
  const loweredAgent = agentName.toLowerCase();
  return name.includes(loweredAgent) || key.includes(loweredAgent);
}

function timelineReplayPrimarySession(sessions: AgentSummary[]): AgentSummary | null {
  if (sessions.length === 0) return null;
  const statusWeight = (status: string) => {
    switch (status) {
      case 'running': return 4;
      case 'reviewing': return 3;
      case 'waiting': return 2;
      case 'idle': return 1;
      default: return 0;
    }
  };
  return [...sessions].sort((a, b) => {
    if (Boolean(a.isCurrentSession) !== Boolean(b.isCurrentSession)) return a.isCurrentSession ? -1 : 1;
    const delta = statusWeight(b.status) - statusWeight(a.status);
    if (delta !== 0) return delta;
    return new Date(b.lastEventAt || 0).getTime() - new Date(a.lastEventAt || 0).getTime();
  })[0] ?? null;
}

function TimelineExpanded() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [segments, setSegments] = useState<ReplaySegment[]>([]);
  const [sessions, setSessions] = useState<AgentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const fetchReplay = async () => {
      try {
        if (segments.length === 0) setLoading(true);
        setError(null);
        const [timelineRes, inboxRes] = await Promise.all([
          fetch('/api/panel/timeline', { cache: 'no-store' }).catch(() => null),
          fetch('/api/mobile/inbox', { cache: 'no-store' }).catch(() => null),
        ]);

        if (timelineRes?.ok) {
          const timelineData = await timelineRes.json() as { segments?: ReplaySegment[] };
          if (active) {
            setSegments(timelineData.segments ?? []);
            setGeneratedAt(new Date().toISOString());
          }
        } else if (active) {
          setSegments([]);
        }

        if (inboxRes?.ok) {
          const inboxData = await inboxRes.json() as MobileInboxSnapshot;
          if (active) setSessions(inboxData.sessions ?? []);
        } else if (active) {
          setSessions([]);
        }
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : 'Unable to load session replay.');
          setSegments([]);
        }
      } finally {
        if (active) setLoading(false);
      }
    };

    void fetchReplay();
    const interval = setInterval(fetchReplay, 30_000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const node = containerRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const nextWidth = entries[0]?.contentRect.width ?? 0;
      setContainerWidth(nextWidth);
    });
    observer.observe(node);
    setContainerWidth(node.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);

  const colors: Record<string, string> = {
    coding: THEME_ACCENT,
    thinking: '#9aa8bd',
    testing: '#d9a441',
    error: '#ef4444',
    idle: 'rgba(255, 255, 255, 0.14)',
  };
  const labels: Record<string, string> = {
    coding: 'CODING', thinking: 'THINKING', testing: 'TESTING', error: 'ERRORS', idle: 'IDLE',
  };

  const totalMin = segments.length > 0 ? segments[segments.length - 1].startMin + segments[segments.length - 1].durationMin : 0;
  const totals = useMemo(() => {
    const map: Record<string, number> = {};
    for (const segment of segments) map[segment.kind] = (map[segment.kind] || 0) + segment.durationMin;
    return map;
  }, [segments]);

  const agentBreakdown = useMemo(() => {
    const map = new Map<string, { agent: string; segments: ReplaySegment[]; totalMin: number; breakdown: Record<string, number> }>();
    for (const segment of segments) {
      const agent = segment.agent || 'Unscoped';
      if (!map.has(agent)) map.set(agent, { agent, segments: [], totalMin: 0, breakdown: {} });
      const entry = map.get(agent)!;
      entry.segments.push(segment);
      entry.totalMin += segment.durationMin;
      entry.breakdown[segment.kind] = (entry.breakdown[segment.kind] || 0) + segment.durationMin;
    }
    return Array.from(map.values()).sort((a, b) => b.totalMin - a.totalMin);
  }, [segments]);

  const liveSessionContext = useMemo(() => {
    const contexts = new Map<string, {
      runtime: string;
      label: string;
      location: string | null;
      summary: string;
      extra: string | null;
    }>();

    for (const agent of agentBreakdown) {
      const matches = sessions.filter((session) => timelineReplayMatchesAgent(agent.agent, session));
      const primary = timelineReplayPrimarySession(matches);
      if (!primary) continue;

      const repoSlug = primary.runtimeSurface?.reviewContext?.repoSlug || '';
      const repoName = repoSlug.split('/')[1] || null;
      const location = repoName
        ? `${repoName}${primary.branch ? ` · ${primary.branch}` : ''}`
        : timelineReplayWorkspace(primary.workspace) ?? primary.surfaceLabel ?? primary.branch ?? null;

      contexts.set(agent.agent, {
        runtime: timelineReplayRuntimeLabel(primary.runtime),
        label: primary.surfaceLabel || primary.name || timelineReplayRuntimeLabel(primary.runtime),
        location,
        summary: timelineReplayTask(primary.currentTask) || primary.surfaceLabel || primary.name || 'No current task detail',
        extra: matches.length > 1 ? `+${matches.length - 1} more live` : null,
      });
    }

    return contexts;
  }, [agentBreakdown, sessions]);

  const liveSessions = useMemo(() => {
    return [...sessions]
      .filter((session) => ['running', 'reviewing', 'waiting'].includes(session.status) || session.isCurrentSession)
      .sort((a, b) => {
        if (Boolean(a.isCurrentSession) !== Boolean(b.isCurrentSession)) return a.isCurrentSession ? -1 : 1;
        return new Date(b.lastEventAt || 0).getTime() - new Date(a.lastEventAt || 0).getTime();
      })
      .slice(0, 8);
  }, [sessions]);

  const recentSlices = useMemo(
    () => [...segments].slice(-(containerWidth > 0 && containerWidth < 760 ? 6 : 10)).reverse(),
    [containerWidth, segments],
  );

  const isTight = containerWidth > 0 && containerWidth < 1040;
  const isCompact = containerWidth > 0 && containerWidth < 760;
  const outerPadding = isCompact ? 14 : isTight ? 18 : 24;
  const sectionPadding = isCompact ? 14 : isTight ? 16 : 20;
  const sectionRadius = isCompact ? 16 : 18;
  const titleSize = isCompact ? 18 : 20;
  const introSize = isCompact ? 11 : 12;
  const metricPillPadding = isCompact ? '5px 8px' : '6px 10px';
  const summaryBarHeight = isCompact ? 32 : 40;
  const contentColumns = isTight ? '1fr' : '1.15fr 0.85fr';

  return (
    <div
      className="cortex-themed-scroll"
      style={{
        height: '100%',
        overflow: 'auto',
        padding: outerPadding,
        background: 'var(--t-bg-gradient)',
      }}
      ref={containerRef}
    >
      <div style={{ marginBottom: isCompact ? 14 : 20 }}>
        <h2 style={{ fontSize: titleSize, fontWeight: 800, letterSpacing: '-0.03em', color: 'var(--t-text)', margin: 0 }}>
          Session Replay
        </h2>
        <p style={{ fontSize: introSize, color: 'var(--t-text-muted)', marginTop: 6, lineHeight: 1.5, maxWidth: isCompact ? '100%' : 680 }}>
          Real timeline aggregation from active app sessions and local runtimes. This view shows what is happening, where it is happening, and which surface is doing the work.
        </p>
      </div>

      {loading ? (
        <div style={{
          background: 'var(--t-panel)',
          borderRadius: sectionRadius,
          padding: sectionPadding,
          border: '1px solid var(--t-divider)',
          color: 'var(--t-text-muted)',
          fontSize: 13,
        }}>
          Loading session replay…
        </div>
      ) : error ? (
        <div style={{
          background: 'rgba(239,68,68,0.08)',
          borderRadius: sectionRadius,
          padding: sectionPadding,
          border: '1px solid rgba(239,68,68,0.18)',
          color: '#b91c1c',
          fontSize: 13,
        }}>
          {error}
        </div>
      ) : segments.length === 0 ? (
        <div style={{
          background: 'var(--t-panel)',
          borderRadius: sectionRadius,
          padding: sectionPadding,
          border: '1px solid var(--t-divider)',
          color: 'var(--t-text-muted)',
          fontSize: 13,
        }}>
          No replay data is available yet. This surface only shows real session activity.
        </div>
      ) : (
        <>
          <div style={{
            background: 'var(--t-panel)',
            borderRadius: sectionRadius,
            padding: isCompact ? 16 : isTight ? 18 : 22,
            marginBottom: isCompact ? 14 : 18,
            border: '1px solid var(--t-divider)',
            boxShadow: 'var(--t-panel-shadow)',
          }}>
            <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, marginBottom: isCompact ? 12 : 16, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t-text-secondary)' }}>
                  Today
                </div>
                <div style={{ marginTop: 4, fontSize: isCompact ? 16 : 18, fontWeight: 800, letterSpacing: '-0.03em', color: 'var(--t-text)' }}>
                  {timelineReplayTime(0)} → {timelineReplayTime(totalMin)}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ padding: metricPillPadding, borderRadius: 999, background: THEME_ACCENT_SOFT, border: `1px solid ${THEME_ACCENT_BORDER}`, color: THEME_ACCENT, fontSize: isCompact ? 10 : 11, fontWeight: 700 }}>
                  {timelineReplayDuration(totalMin)} total
                </span>
                <span style={{ padding: metricPillPadding, borderRadius: 999, background: 'var(--t-divider-subtle)', border: '1px solid var(--t-panel-border)', color: 'var(--t-text-secondary)', fontSize: isCompact ? 10 : 11, fontWeight: 700 }}>
                  {agentBreakdown.length} active lanes
                </span>
                <span style={{ padding: metricPillPadding, borderRadius: 999, background: 'rgba(34, 197, 94, 0.12)', border: '1px solid rgba(34, 197, 94, 0.18)', color: '#4ade80', fontSize: isCompact ? 10 : 11, fontWeight: 700 }}>
                  {liveSessions.length} live surfaces
                </span>
              </div>
            </div>

            <div style={{ height: summaryBarHeight, borderRadius: isCompact ? 8 : 10, overflow: 'hidden', display: 'flex', background: 'var(--t-divider-subtle)', border: '1px solid var(--t-panel-border)' }}>
              {segments.map((seg, i) => (
                <div
                  key={`${seg.agent ?? 'unscoped'}:${seg.kind}:${seg.startMin}:${i}`}
                  style={{
                    width: `${(seg.durationMin / totalMin) * 100}%`,
                    height: '100%',
                    background: colors[seg.kind] || '#e5e7eb',
                    borderRight: i < segments.length - 1 ? '1px solid rgba(255,255,255,0.08)' : 'none',
                  }}
                  title={`${labels[seg.kind] || seg.kind} · ${seg.agent ?? 'Unknown'} · ${timelineReplayDuration(seg.durationMin)} · ${timelineReplayTime(seg.startMin)}`}
                />
              ))}
            </div>

            <div style={{ display: 'flex', gap: isCompact ? 12 : 18, marginTop: isCompact ? 10 : 14, flexWrap: 'wrap' }}>
              {(['thinking', 'coding', 'testing', 'error'] as const).map((kind) => {
                const total = totals[kind];
                if (!total) return null;
                return (
                  <div key={kind} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <div style={{ width: 10, height: 10, borderRadius: 999, background: colors[kind] }} />
                    <span style={{ fontSize: isCompact ? 10 : 11, fontWeight: 700, color: 'var(--t-text)' }}>{labels[kind]}</span>
                    <span style={{ fontSize: isCompact ? 10 : 11, color: 'var(--t-text-muted)' }}>{timelineReplayDuration(total)}</span>
                  </div>
                );
              })}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: contentColumns, gap: isCompact ? 14 : 18, marginBottom: isCompact ? 14 : 18 }}>
            <div style={{
              background: 'var(--t-panel)',
              borderRadius: sectionRadius,
              padding: sectionPadding,
              border: '1px solid var(--t-divider)',
              boxShadow: 'var(--t-panel-shadow)',
            }}>
              <div style={{ display: 'flex', alignItems: isCompact ? 'flex-start' : 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginBottom: isCompact ? 12 : 16 }}>
                <h3 style={{ fontSize: isCompact ? 11 : 12, fontWeight: 700, color: 'var(--t-text)', letterSpacing: '0.05em', textTransform: 'uppercase', margin: 0 }}>
                  Replay Lanes
                </h3>
                <span style={{ fontSize: 10, color: 'var(--t-text-muted)', fontWeight: 600 }}>
                  Generated {generatedAt ? formatAge(generatedAt) : 'just now'}
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: isCompact ? 10 : 14 }}>
                {agentBreakdown.map((entry) => {
                  const context = liveSessionContext.get(entry.agent);
                  const runtimePalette = sessionReplayRuntimePalette(context?.runtime);
                  return (
                    <div key={entry.agent} style={{
                      borderRadius: isCompact ? 14 : 16,
                      border: '1px solid var(--t-panel-border)',
                      padding: isCompact ? 12 : 16,
                      background: REPLAY_CARD_BACKGROUND,
                      boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.03)',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: isCompact ? 14 : 15, fontWeight: 800, color: 'var(--t-text)', letterSpacing: '-0.02em' }}>{entry.agent}</div>
                          <div style={{ fontSize: isCompact ? 10 : 11, color: 'var(--t-text-muted)', marginTop: 3 }}>
                            {context?.label ?? 'Historical lane without a live matched surface'}
                          </div>
                        </div>
                        <div style={{ fontSize: isCompact ? 11 : 12, fontWeight: 700, color: 'var(--t-text-secondary)', fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                          {timelineReplayDuration(entry.totalMin)}
                        </div>
                      </div>

                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                        {context ? (
                          <>
                            <span style={{ fontSize: isCompact ? 9 : 10, fontWeight: 700, color: runtimePalette.color, background: runtimePalette.background, border: `1px solid ${runtimePalette.border}`, borderRadius: 999, padding: isCompact ? '2px 7px' : '3px 8px' }}>
                              {context.runtime}
                            </span>
                            {context.location ? (
                              <span style={{ fontSize: isCompact ? 9 : 10, fontWeight: 600, color: 'var(--t-text-secondary)', background: 'var(--t-divider-subtle)', border: '1px solid var(--t-panel-border)', borderRadius: 999, padding: isCompact ? '2px 7px' : '3px 8px', fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                                {context.location}
                              </span>
                            ) : null}
                            {context.extra ? (
                              <span style={{ fontSize: isCompact ? 9 : 10, fontWeight: 600, color: 'var(--t-text-muted)', background: 'var(--t-divider-subtle)', border: '1px solid var(--t-panel-border)', borderRadius: 999, padding: isCompact ? '2px 7px' : '3px 8px' }}>
                                {context.extra}
                              </span>
                            ) : null}
                          </>
                        ) : null}
                      </div>

                      <div style={{ marginTop: 8, fontSize: isCompact ? 11 : 12, lineHeight: 1.5, color: 'var(--t-text-secondary)' }}>
                        {context?.summary ?? 'No live session detail matched for this lane yet. The replay bar is still showing real recorded activity.'}
                      </div>

                      <div style={{ height: isCompact ? 10 : 12, borderRadius: 999, overflow: 'hidden', display: 'flex', background: 'var(--t-divider-subtle)', border: '1px solid var(--t-panel-border)', marginTop: 10 }}>
                        {entry.segments.map((seg, i) => (
                          <div
                            key={`${entry.agent}:${seg.kind}:${seg.startMin}:${i}`}
                            style={{
                              width: `${(seg.durationMin / entry.totalMin) * 100}%`,
                              height: '100%',
                              background: colors[seg.kind] || '#e5e7eb',
                            }}
                            title={`${labels[seg.kind] || seg.kind} · ${timelineReplayDuration(seg.durationMin)} · ${timelineReplayTime(seg.startMin)}`}
                          />
                        ))}
                      </div>

                      <div style={{ display: 'flex', gap: isCompact ? 8 : 12, flexWrap: 'wrap', marginTop: 8 }}>
                        {(['coding', 'thinking', 'testing', 'error'] as const).map((kind) => {
                          const minutes = entry.breakdown[kind];
                          if (!minutes) return null;
                          return (
                            <div key={kind} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                              <div style={{ width: 6, height: 6, borderRadius: 999, background: colors[kind] }} />
                              <span style={{ fontSize: isCompact ? 9 : 10, color: 'var(--t-text-muted)', fontWeight: 600 }}>
                                {labels[kind]} {timelineReplayDuration(minutes)}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              <div style={{
                background: 'var(--t-panel)',
                borderRadius: sectionRadius,
                padding: sectionPadding,
                border: '1px solid var(--t-divider)',
                boxShadow: 'var(--t-panel-shadow)',
              }}>
                <h3 style={{ fontSize: isCompact ? 11 : 12, fontWeight: 700, color: 'var(--t-text)', letterSpacing: '0.05em', textTransform: 'uppercase', margin: `0 0 ${isCompact ? 12 : 16}px` }}>
                  Live Surfaces
                </h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: isCompact ? 10 : 12 }}>
                  {liveSessions.map((session) => {
                    const runtime = timelineReplayRuntimeLabel(session.runtime);
                    const repoSlug = session.runtimeSurface?.reviewContext?.repoSlug || '';
                    const repoName = repoSlug.split('/')[1] || null;
                    const location = repoName
                      ? `${repoName}${session.branch ? ` · ${session.branch}` : ''}`
                      : timelineReplayWorkspace(session.workspace) ?? session.surfaceLabel ?? session.branch ?? 'unknown';
                    const runtimePalette = sessionReplayRuntimePalette(runtime);

                    return (
                      <div key={session.sessionKey} style={{
                        borderRadius: isCompact ? 12 : 14,
                        border: '1px solid var(--t-panel-border)',
                        padding: isCompact ? 12 : 14,
                        background: REPLAY_CARD_BACKGROUND,
                        boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.03)',
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: isCompact ? 12 : 13, fontWeight: 700, color: 'var(--t-text)', letterSpacing: '-0.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {session.name}
                            </div>
                            <div style={{ fontSize: isCompact ? 10 : 10.5, color: 'var(--t-text-muted)', marginTop: 3 }}>
                              {location}
                            </div>
                          </div>
                          <span style={{ fontSize: isCompact ? 9 : 10, fontWeight: 700, color: runtimePalette.color, background: runtimePalette.background, border: `1px solid ${runtimePalette.border}`, borderRadius: 999, padding: isCompact ? '2px 7px' : '3px 8px', flexShrink: 0 }}>
                            {runtime}
                          </span>
                        </div>
                        <div style={{ fontSize: isCompact ? 10.5 : 11.5, lineHeight: 1.5, color: 'var(--t-text-secondary)', marginTop: 8 }}>
                          {timelineReplayTask(session.currentTask) || 'No current task detail'}
                        </div>
                        <div style={{ fontSize: isCompact ? 9 : 10, color: 'var(--t-text-muted)', marginTop: 8 }}>
                          {session.surfaceLabel || session.status} · {formatAge(session.lastEventAt)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div style={{
                background: 'var(--t-panel)',
                borderRadius: sectionRadius,
                padding: sectionPadding,
                border: '1px solid var(--t-divider)',
                boxShadow: 'var(--t-panel-shadow)',
              }}>
                <h3 style={{ fontSize: isCompact ? 11 : 12, fontWeight: 700, color: 'var(--t-text)', letterSpacing: '0.05em', textTransform: 'uppercase', margin: `0 0 ${isCompact ? 12 : 16}px` }}>
                  Recent Slices
                </h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: isCompact ? 8 : 10 }}>
                  {recentSlices.map((segment, index) => (
                    <div key={`${segment.agent ?? 'unscoped'}:${segment.kind}:${segment.startMin}:${index}`} style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      paddingBottom: isCompact ? 8 : 10,
                      borderBottom: index < recentSlices.length - 1 ? '1px solid var(--t-divider-subtle)' : 'none',
                    }}>
                      <div style={{ width: 8, height: 8, borderRadius: 999, background: colors[segment.kind] || '#e5e7eb', flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: isCompact ? 11 : 12, fontWeight: 600, color: 'var(--t-text)' }}>
                          {(labels[segment.kind] || segment.kind)} · {segment.agent ?? 'Unscoped'}
                        </div>
                        <div style={{ fontSize: isCompact ? 9.5 : 10.5, color: 'var(--t-text-muted)', marginTop: 2 }}>
                          {timelineReplayTime(segment.startMin)} · {timelineReplayDuration(segment.durationMin)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── Issue Viewer ──

interface IssueDetail {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: { name: string; color: string }[];
  author: string;
  createdAt: string;
  comments: number;
  url: string;
}

const IssueViewer = memo(function IssueViewer({
  issueNumber,
  repo,
  onLaunchWorkspaceTask,
}: {
  issueNumber: number;
  repo?: string;
  onLaunchWorkspaceTask?: (request: CanvasRepoTaskLaunchRequest) => Promise<void>;
}) {
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [localRepo, setLocalRepo] = useState<Pick<RepoRegistryEntry, 'name' | 'localPath' | 'readiness'> | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const repoParam = repo ? `?repo=${encodeURIComponent(repo)}` : '';
    fetch(`/api/panel/issues/${issueNumber}${repoParam}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (!cancelled) {
          setDetail(data.issue ?? data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message);
          setLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [issueNumber]);

  useEffect(() => {
    if (!repo) {
      setLocalRepo(null);
      return;
    }
    let cancelled = false;
    fetch('/api/panel/repos')
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const match = (data.repos ?? []).find((entry: RepoRegistryEntry) => repoSlugFromRemote(entry.remoteUrl) === repo);
        setLocalRepo(match ? { name: match.name, localPath: match.localPath, readiness: match.readiness } : null);
      })
      .catch(() => {
        if (!cancelled) setLocalRepo(null);
      });
    return () => { cancelled = true; };
  }, [repo]);

  if (loading) {
    return (
      <div style={{ padding: 32, color: 'var(--t-text-muted)', fontSize: 13 }}>
        Loading issue #{issueNumber}...
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div style={{ padding: 32, color: '#ef4444', fontSize: 13 }}>
        Failed to load issue #{issueNumber}: {error || 'Unknown error'}
      </div>
    );
  }

  const stateColor = detail.state === 'open' ? '#34c759' : '#8b5cf6';
  const age = formatAge(detail.createdAt);

  return (
    <div style={{ padding: '24px 32px' }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        marginBottom: 20,
      }}>
        <div style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          backgroundColor: stateColor,
          marginTop: 8,
          flexShrink: 0,
        }} />
        <div style={{ flex: 1 }}>
          <h2 style={{
            fontSize: 20,
            fontWeight: 700,
            letterSpacing: '-0.03em',
            color: 'var(--t-text-strong)',
            margin: 0,
            lineHeight: 1.3,
          }}>
            #{detail.number} {detail.title}
          </h2>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            marginTop: 8,
            fontSize: 12,
            color: 'var(--t-text-muted)',
          }}>
            <span>{detail.author}</span>
            <span>·</span>
            <span>{age}</span>
            <span>·</span>
            <span>{detail.comments} comment{detail.comments !== 1 ? 's' : ''}</span>
            <a
              href={detail.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                color: 'var(--t-text-secondary)',
                textDecoration: 'none',
                marginLeft: 'auto',
              }}
            >
              <ExternalLink size={12} />
              GitHub
            </a>
          </div>
          {/* Labels */}
          {detail.labels.length > 0 && (
            <div style={{
              display: 'flex',
              gap: 6,
              flexWrap: 'wrap',
              marginTop: 10,
            }}>
              {detail.labels.map((l) => (
                <span
                  key={l.name}
                  style={{
                    fontSize: 11,
                    fontWeight: 500,
                    padding: '2px 8px',
                    borderRadius: 6,
                    backgroundColor: `#${l.color}18`,
                    color: `#${l.color}`,
                    border: `1px solid #${l.color}30`,
                  }}
                >
                  {l.name}
                </span>
              ))}
            </div>
          )}
          {repo && onLaunchWorkspaceTask ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 14 }}>
              {localRepo?.readiness ? (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                    padding: '10px 12px',
                    borderRadius: 12,
                    border: `1px solid ${readinessTone(localRepo.readiness).border}`,
                    background: readinessTone(localRepo.readiness).background,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: readinessTone(localRepo.readiness).color }}>
                      {localRepo.name} · {localRepo.readiness.label}
                    </span>
                    {localRepo.readiness.currentBranch ? (
                      <span style={{ fontSize: 11, color: 'var(--t-text-muted)', fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                        {localRepo.readiness.currentBranch}
                      </span>
                    ) : null}
                  </div>
                  <div style={{ fontSize: 12, lineHeight: 1.45, color: 'var(--t-text-secondary)' }}>
                    {localRepo.readiness.summary}
                  </div>
                  {localRepo.readiness.nextAction ? (
                    <div style={{ fontSize: 11, lineHeight: 1.45, color: 'var(--t-text-muted)' }}>
                      {localRepo.readiness.nextAction}
                    </div>
                  ) : null}
                </div>
              ) : null}
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button
                type="button"
                disabled={launching}
                onClick={() => {
                  setLaunching(true);
                  void onLaunchWorkspaceTask({
                    kind: 'issue',
                    repo,
                    number: detail.number,
                    title: detail.title,
                    body: detail.body,
                  }).finally(() => setLaunching(false));
                }}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  height: 32,
                  padding: '0 12px',
                  borderRadius: 10,
                  border: '1px solid rgba(37, 99, 235, 0.18)',
                  background: 'rgba(37, 99, 235, 0.08)',
                  color: launching ? '#94a3b8' : '#1d4ed8',
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: launching ? 'default' : 'pointer',
                }}
              >
                <Play size={13} />
                {launching ? 'Launching…' : 'Launch In Workspace'}
              </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* Body */}
      <div style={{
        background: 'var(--t-panel-translucent)',
        borderRadius: 14,
        padding: '20px 24px',
        border: '1px solid var(--t-divider-subtle)',
        fontSize: 14,
        lineHeight: 1.65,
        color: 'var(--t-text)',
        letterSpacing: '-0.01em',
      }}>
        <MarkdownBody text={detail.body || '*No description.*'} />
      </div>
    </div>
  );
});

// ── Transcript Viewer ──

const TranscriptViewer = memo(function TranscriptViewer({ sessionKey }: { sessionKey: string }) {
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    fetch(`/api/mobile/history?sessionKey=${encodeURIComponent(sessionKey)}&limit=100`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && Array.isArray(data)) {
          setMessages(data);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [sessionKey]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  if (loading) {
    return (
      <div style={{ padding: 32, color: 'var(--t-text-muted)', fontSize: 13 }}>
        Loading transcript...
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      style={{
        padding: '16px 24px',
        overflowY: 'auto',
        height: '100%',
      }}
    >
      {messages.length === 0 ? (
        <div style={{ color: 'var(--t-text-muted)', fontSize: 13, padding: 16 }}>
          No messages in this session.
        </div>
      ) : (
        messages.map((msg, i) => (
          <div
            key={i}
            style={{
              marginBottom: 12,
              padding: '10px 14px',
              borderRadius: 12,
              background: msg.role === 'assistant'
                ? 'var(--t-panel-translucent)'
                : 'rgba(37, 99, 235, 0.04)',
              border: '1px solid var(--t-divider-subtle)',
              fontSize: 13,
              lineHeight: 1.55,
              color: 'var(--t-text)',
            }}
          >
            <div style={{
              fontSize: 11,
              fontWeight: 600,
              color: msg.role === 'assistant' ? 'var(--t-text-secondary)' : '#2563eb',
              marginBottom: 4,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}>
              {msg.role}
            </div>
            <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {(() => {
                const raw = typeof msg.content === 'string'
                  ? msg.content.slice(0, 2000)
                  : JSON.stringify(msg.content).slice(0, 2000);
                // Redact credentials/tokens before rendering
                return raw
                  .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, 'Bearer [redacted]')
                  .replace(/\b(?:api[_-]?key|access[_-]?token|secret|password|token)\b(\s*[:=]\s*)([^\s"'`]+)/gi, '$1[redacted]')
                  .replace(/\b(?:ghp_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{12,})\b/g, '[redacted]');
              })()}
            </div>
          </div>
        ))
      )}
    </div>
  );
});

interface TranscriptMessage {
  role: string;
  content: string | object;
}

// ── File Viewer ──

// Monaco language mapping from file extension
function getMonacoLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const name = path.split('/').pop()?.toLowerCase() ?? '';
  if (name.startsWith('.env')) return 'ini';
  if (name === 'dockerfile') return 'dockerfile';
  if (name === '.gitignore' || name === '.dockerignore') return 'plaintext';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
    md: 'markdown', mdx: 'markdown', html: 'html', xml: 'xml',
    css: 'css', scss: 'scss', less: 'less',
    py: 'python', rs: 'rust', go: 'go', rb: 'ruby', java: 'java',
    c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
    sh: 'shell', bash: 'shell', zsh: 'shell',
    sql: 'sql', graphql: 'graphql', gql: 'graphql',
    swift: 'swift', kt: 'kotlin',
    r: 'r', lua: 'lua', php: 'php', perl: 'perl',
    ini: 'ini', conf: 'ini', cfg: 'ini',
  };
  return map[ext] || 'plaintext';
}

function defineCortexMonacoThemes(monaco: typeof import('monaco-editor')) {
  monaco.editor.defineTheme('cortex-graphite', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '8f99a6', fontStyle: 'italic' },
      { token: 'keyword', foreground: '9db5ff' },
      { token: 'string', foreground: '7fd6b7' },
      { token: 'number', foreground: 'f1b57f' },
      { token: 'type', foreground: 'd6c48f' },
      { token: 'variable', foreground: 'f2a8b8' },
      { token: 'function', foreground: '8fc0ff' },
    ],
    colors: {
      'editor.background': '#3d434b',
      'editor.foreground': '#eef3f8',
      'editor.lineHighlightBackground': '#49515b',
      'editor.selectionBackground': '#7aa2ff33',
      'editorLineNumber.foreground': '#8893a0',
      'editorLineNumber.activeForeground': '#dbe4ee',
      'editor.inactiveSelectionBackground': '#7aa2ff1f',
      'editorCursor.foreground': '#7aa2ff',
      'editorGutter.background': '#3d434b',
      'editorWidget.background': '#444b55',
      'editorWidget.border': '#65707d',
      'input.background': '#343a42',
      'input.border': '#65707d',
      'focusBorder': '#7aa2ff',
      'minimap.background': '#3d434b',
      'scrollbarSlider.background': '#65707d88',
      'scrollbarSlider.hoverBackground': '#7b879488',
      'diffEditor.insertedTextBackground': '#16653433',
      'diffEditor.insertedLineBackground': '#1665341f',
      'diffEditor.removedTextBackground': '#1d4ed833',
      'diffEditor.removedLineBackground': '#1d4ed81f',
      'diffEditor.diagonalFill': '#3d434b',
    },
  });

  monaco.editor.defineTheme('cortex-frost', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '94a3b8', fontStyle: 'italic' },
      { token: 'keyword', foreground: '6366f1' },
      { token: 'string', foreground: '0d9488' },
      { token: 'number', foreground: 'e879a0' },
      { token: 'type', foreground: '8b5cf6' },
      { token: 'variable', foreground: '0284c7' },
      { token: 'function', foreground: '4f46e5' },
      { token: 'delimiter', foreground: '94a3b8' },
      { token: 'tag', foreground: 'e879a0' },
      { token: 'attribute.name', foreground: '8b5cf6' },
      { token: 'attribute.value', foreground: '0d9488' },
      { token: 'operator', foreground: '64748b' },
      { token: 'regexp', foreground: 'e879a0' },
    ],
    colors: {
      'editor.background': '#f0f7ff',
      'editor.foreground': '#1e293b',
      'editor.lineHighlightBackground': '#e8f1fc',
      'editor.selectionBackground': '#c7d2fe',
      'editorLineNumber.foreground': '#94a3b8',
      'editorLineNumber.activeForeground': '#475569',
      'editor.inactiveSelectionBackground': '#c7d2fe60',
      'editorCursor.foreground': '#4f46e5',
      'editorGutter.background': '#f0f7ff',
      'editorWidget.background': '#f8fafc',
      'editorWidget.border': '#cbd5e1',
      'input.background': '#ffffff',
      'input.border': '#cbd5e1',
      'focusBorder': '#6366f1',
      'minimap.background': '#f0f7ff',
      'scrollbarSlider.background': '#94a3b840',
      'scrollbarSlider.hoverBackground': '#64748b40',
      'editorBracketMatch.background': '#e0e7ff',
      'editorBracketMatch.border': '#a5b4fc',
      'diffEditor.insertedTextBackground': '#dcfce766',
      'diffEditor.insertedLineBackground': '#dcfce740',
      'diffEditor.removedTextBackground': '#dbeafe88',
      'diffEditor.removedLineBackground': '#dbeafe55',
      'diffEditor.diagonalFill': '#f0f7ff',
    },
  });
}

const FileViewer = memo(function FileViewer({ filePath, workspace }: { filePath: string; workspace?: string }) {
  const { themeId } = useTheme();
  const [content, setContent] = useState<string | null>(null);
  const [editContent, setEditContent] = useState<string>('');
  const [diff, setDiff] = useState<string>('');
  const [hasDiff, setHasDiff] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<'content' | 'diff'>('content');
  const [editing, setEditing] = useState(true); // Always editable — click in, start typing
  const editorRef = useRef<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    // Fetch file content
    const wsParam = workspace ? `&workspace=${encodeURIComponent(workspace)}` : '';
    Promise.all([
      fetch(`/api/panel/file-content?path=${encodeURIComponent(filePath)}${wsParam}`)
        .then(r => r.json()).catch(() => ({ content: null })),
      fetch(`/api/panel/file-diff?path=${encodeURIComponent(filePath)}${wsParam}`)
        .then(r => r.json()).catch(() => ({ diff: '', hasDiff: false })),
    ]).then(([contentData, diffData]) => {
      if (!cancelled) {
        setContent(contentData.content ?? null);
        setEditContent(contentData.content ?? '');
        setDiff(diffData.diff ?? '');
        setHasDiff(diffData.hasDiff ?? false);
        if (diffData.hasDiff) setActiveView('diff');
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
      tabCompleteDisposableRef.current?.dispose();
      tabCompleteAbortRef.current?.abort();
    };
  }, [filePath, workspace]);

  // Save file via API
  const handleSave = useCallback(async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setSaveNote(null);
    try {
      const res = await fetch('/api/v2/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath, content: editContent, workspace }),
      });
      if (res.ok) {
        setContent(editContent);
        setDirty(false);
        setSaveNote('Saved');
        setTimeout(() => setSaveNote(null), 2000);
      } else {
        const data = await res.json().catch(() => ({}));
        setSaveNote(`Error: ${(data as Record<string, string>).error ?? 'Save failed'}`);
      }
    } catch (err) {
      setSaveNote(`Error: ${err instanceof Error ? err.message : 'Save failed'}`);
    } finally {
      setSaving(false);
    }
  }, [dirty, saving, filePath, editContent]);

  // Cmd+S keyboard shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's' && editing) {
        e.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [editing, handleSave]);

  // Inline edit state
  const [inlineEditOpen, setInlineEditOpen] = useState(false);
  const [inlineEditPrompt, setInlineEditPrompt] = useState('');
  const [inlineEditLoading, setInlineEditLoading] = useState(false);
  const [inlineEditResponse, setInlineEditResponse] = useState('');
  const [inlineEditMode, setInlineEditMode] = useState<'edit' | 'explain'>('edit');
  const [inlineEditAgent, setInlineEditAgent] = useState<'flash' | 'sonnet' | 'opus'>('flash');
  // Diff preview for accept/reject
  const [pendingDiff, setPendingDiff] = useState<{ original: string; modified: string; selection: import('monaco-editor').IRange | null; isFullFile: boolean } | null>(null);
  // Prompt history
  const [promptHistory] = useState<string[]>(() => {
    if (typeof window === 'undefined') return [];
    try { return JSON.parse(localStorage.getItem('cortex.inline-edit-history') ?? '[]'); } catch { return []; }
  });
  const [historyIndex, setHistoryIndex] = useState(-1);
  const inlineEditInputRef = useRef<HTMLInputElement>(null);
  const inlineWidgetRef = useRef<{ dispose: () => void } | null>(null);
  const inlineWidgetDomRef = useRef<HTMLDivElement | null>(null);
  const monacoRef = useRef<typeof import('monaco-editor') | null>(null);
  const cursorLineRef = useRef(1);

  // Tab completion abort controller
  const tabCompleteAbortRef = useRef<AbortController | null>(null);
  const tabCompleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tabCompleteDisposableRef = useRef<{ dispose: () => void } | null>(null);

  // Monaco editor mount handler
  const handleEditorMount = useCallback((editor: unknown) => {
    editorRef.current = editor;

    loader.init().then((monaco) => {
      monacoRef.current = monaco;
      const ed = editor as import('monaco-editor').editor.IStandaloneCodeEditor;

      // Cmd+S — save
      ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        void handleSave();
      });

      // Track cursor line for widget positioning
      ed.onDidChangeCursorPosition((e) => {
        cursorLineRef.current = e.position.lineNumber;
      });

      // Cmd+E — inline AI edit widget
      ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyE, () => {
        const pos = ed.getPosition();
        if (pos) cursorLineRef.current = pos.lineNumber;

        // Remove existing widget
        if (inlineWidgetRef.current) {
          inlineWidgetRef.current.dispose();
          inlineWidgetRef.current = null;
        }

        // Create widget DOM
        if (!inlineWidgetDomRef.current) {
          inlineWidgetDomRef.current = document.createElement('div');
          inlineWidgetDomRef.current.id = 'cortex-inline-widget';
        }

        const lineNumber = cursorLineRef.current;
        const widget = {
          getId: () => 'cortex.inline.edit',
          getDomNode: () => inlineWidgetDomRef.current!,
          getPosition: () => ({
            position: { lineNumber, column: 1 },
            preference: [monaco.editor.ContentWidgetPositionPreference.BELOW],
          }),
        };

        ed.addContentWidget(widget);
        inlineWidgetRef.current = { dispose: () => ed.removeContentWidget(widget) };

        setInlineEditOpen(true);
        setInlineEditResponse('');
        setInlineEditMode('edit');
        setTimeout(() => inlineEditInputRef.current?.focus(), 80);
      });

      // Tab autocomplete — disabled for now (Monaco internal lifecycle crash)
      // Will re-enable with a debounced widget approach instead of inline provider
      /* eslint-disable @typescript-eslint/no-unused-vars -- kept for re-enable */
      // Tab autocomplete disabled — Monaco internal lifecycle crash on cancel
      // Will re-implement with widget-based approach
    });
  }, [handleSave, filePath]);

  // Agent model mapping
  const agentModels: Record<string, { provider: string; model: string }> = {
    flash: { provider: 'google', model: 'gemini-2.5-flash' },
    sonnet: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
    opus: { provider: 'anthropic', model: 'claude-opus-4-6-20250929' },
  };

  // Handle inline edit submission
  const handleInlineEdit = useCallback(async () => {
    const ed = editorRef.current as import('monaco-editor').editor.IStandaloneCodeEditor | null;
    if (!ed || !inlineEditPrompt.trim() || inlineEditLoading) return;

    const selection = ed.getSelection();
    const model = ed.getModel();
    if (!model) return;

    const selectedText = selection && !selection.isEmpty()
      ? model.getValueInRange(selection)
      : model.getValue();
    const isFullFile = !selection || selection.isEmpty();
    const language = getMonacoLanguage(filePath);

    // Detect mode: if prompt starts with "explain" or "?", use explain mode
    const trimmed = inlineEditPrompt.trim();
    const isExplain = /^(explain|what|why|how|\?)/.test(trimmed.toLowerCase());
    setInlineEditMode(isExplain ? 'explain' : 'edit');
    setInlineEditLoading(true);
    setInlineEditResponse('');

    const { provider, model: llmModel } = agentModels[inlineEditAgent];
    const systemPrompt = isExplain
      ? `You are a senior developer explaining code. Be concise (max 4 sentences). No markdown fences.`
      : `You are a code editor. Output ONLY modified code. No explanations. No markdown fences. No conversation. If the instruction is unclear, return the code unchanged.`;

    const userContent = isExplain
      ? `${trimmed}\n\nCODE:\n${selectedText}`
      : `Rewrite this ${language} code to: ${trimmed}\n\nSELECTED CODE:\n${selectedText}`;

    try {
      const res = await fetch('/api/v2/proxy/llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          model: llmModel,
          messages: [
            { role: 'user', content: `${systemPrompt}\n\n${userContent}` },
          ],
          max_tokens: 4096,
        }),
      });

      if (!res.ok) throw new Error('LLM request failed');

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');
      const decoder = new TextDecoder();
      let result = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
          try {
            const event = JSON.parse(line.slice(6)) as Record<string, unknown>;
            if (event.type === 'content' || event.type === 'delta') {
              result += (event.text ?? '') as string;
              // Stream response into the widget
              if (isExplain) setInlineEditResponse(result);
            }
          } catch { /* skip */ }
        }
      }

      if (isExplain) {
        // Just show the explanation — don't modify code
        setInlineEditResponse(result.trim());
        setInlineEditLoading(false);
        return;
      }

      if (result.trim()) {
        let cleaned = result.trim();
        if (cleaned.startsWith('```')) {
          cleaned = cleaned.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
        }

        // Show diff preview — don't auto-apply
        setPendingDiff({
          original: selectedText,
          modified: cleaned,
          selection: isFullFile ? null : (selection ?? null),
          isFullFile,
        });
      }

      // Save to history
      const prompt = inlineEditPrompt.trim();
      if (prompt) {
        const newHistory = [prompt, ...promptHistory.filter(h => h !== prompt)].slice(0, 10);
        promptHistory.splice(0, promptHistory.length, ...newHistory);
        localStorage.setItem('cortex.inline-edit-history', JSON.stringify(newHistory));
      }
    } catch (err) {
      setInlineEditResponse(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setInlineEditLoading(false);
    }
  }, [inlineEditPrompt, inlineEditLoading, inlineEditAgent, filePath, content, promptHistory]);

  // Accept the pending diff
  const handleAcceptDiff = useCallback(() => {
    const ed = editorRef.current as import('monaco-editor').editor.IStandaloneCodeEditor | null;
    if (!ed || !pendingDiff) return;
    const model = ed.getModel();
    if (!model) return;

    if (pendingDiff.isFullFile) {
      const fullRange = model.getFullModelRange();
      ed.executeEdits('cortex-inline-edit', [{ range: fullRange, text: pendingDiff.modified }]);
    } else if (pendingDiff.selection) {
      ed.executeEdits('cortex-inline-edit', [{ range: pendingDiff.selection, text: pendingDiff.modified }]);
    }

    setEditContent(model.getValue());
    setDirty(model.getValue() !== content);
    setPendingDiff(null);
    setInlineEditOpen(false);
    setInlineEditPrompt('');
    inlineWidgetRef.current?.dispose();
    inlineWidgetRef.current = null;
  }, [pendingDiff, content]);

  // Reject the pending diff
  const handleRejectDiff = useCallback(() => {
    setPendingDiff(null);
  }, []);

  if (loading) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: 'var(--t-text-muted)' }}>Loading file…</div>;
  }

  const fileName = filePath.split('/').pop() ?? filePath;
  const lineCount = (editing ? editContent : content ?? '').split('\n').length;
  const fileSize = new Blob([content ?? '']).size;
  const fileSizeLabel = fileSize > 1024 ? `${(fileSize / 1024).toFixed(1)} KB` : `${fileSize} B`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{
        paddingTop: 12,
        paddingRight: 20,
        paddingBottom: 10,
        paddingLeft: 20,
        borderBottom: '1px solid var(--t-divider)',
        background: 'var(--t-panel-translucent)',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexShrink: 0,
      }}>
        <FileText size={16} strokeWidth={1.8} style={{ color: 'var(--t-text-muted)' }} />
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--t-text)' }}>
          {fileName}{dirty ? ' •' : ''}
        </span>
        <span style={{ fontSize: 11, color: 'var(--t-text-muted)', fontFamily: '"SF Mono", ui-monospace, monospace' }}>{filePath}</span>
        <span style={{ fontSize: 10, color: 'var(--t-text-muted)', opacity: 0.7 }}>{lineCount} lines · {fileSizeLabel}</span>

        {saveNote ? (
          <span style={{
            fontSize: 11,
            fontWeight: 500,
            color: saveNote.startsWith('Error') ? '#ef4444' : '#22c55e',
            marginLeft: 8,
          }}>{saveNote}</span>
        ) : null}

        {/* Save indicator — shows inline when dirty */}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          {dirty ? (
            <span style={{
              fontSize: 11, fontWeight: 500,
              color: saving ? 'var(--t-text-muted)' : '#b45309',
            }}>
              {saving ? 'Saving…' : '⌘S to save'}
            </span>
          ) : null}
        </div>

        {hasDiff && !editing ? (
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 2 }}>
            {(['content', 'diff'] as const).map((view) => (
              <button
                key={view}
                type="button"
                onClick={() => setActiveView(view)}
                style={{
                  paddingTop: 4,
                  paddingRight: 10,
                  paddingBottom: 4,
                  paddingLeft: 10,
                  borderRadius: 6,
                  border: 'none',
                  fontSize: 11,
                  fontWeight: activeView === view ? 600 : 400,
                  color: activeView === view ? '#2563eb' : 'var(--t-text-secondary)',
                  background: activeView === view ? 'rgba(37,99,235,0.08)' : 'transparent',
                  cursor: 'pointer',
                  fontFamily: '-apple-system, system-ui, sans-serif',
                }}
              >
                {view === 'content' ? 'Content' : 'Diff'}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {/* Inline Edit Widget — renders into Monaco content widget via portal */}
      {inlineEditOpen && inlineWidgetDomRef.current && createPortal(
        <div style={{
          width: 420,
          borderRadius: 14,
          border: '1px solid rgba(99, 102, 241, 0.2)',
          background: 'rgba(248, 250, 255, 0.92)',
          backdropFilter: 'blur(20px) saturate(1.2)',
          WebkitBackdropFilter: 'blur(20px) saturate(1.2)',
          boxShadow: '0 8px 32px rgba(0,0,0,0.08), 0 2px 8px rgba(99,102,241,0.06)',
          padding: '10px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          zIndex: 9999,
          fontFamily: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif',
        }}>
          {/* Agent picker pills */}
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <span style={{ fontSize: 10, color: '#6366f1', fontWeight: 600, marginRight: 4 }}>✨</span>
            {(['flash', 'sonnet', 'opus'] as const).map((agent) => (
              <button
                key={agent}
                type="button"
                onClick={() => setInlineEditAgent(agent)}
                style={{
                  padding: '2px 8px', borderRadius: 6, border: 'none',
                  fontSize: 10, fontWeight: inlineEditAgent === agent ? 600 : 400,
                  color: inlineEditAgent === agent ? '#fff' : '#64748b',
                  background: inlineEditAgent === agent
                    ? (agent === 'flash' ? '#6366f1' : agent === 'sonnet' ? '#2563eb' : '#7c3aed')
                    : 'rgba(148,163,184,0.1)',
                  cursor: 'pointer',
                  transition: 'all 120ms ease',
                  textTransform: 'capitalize',
                }}
              >
                {agent}
              </button>
            ))}
            <span style={{ marginLeft: 'auto', fontSize: 9, color: '#94a3b8' }}>⌘E</span>
          </div>

          {/* Input */}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              ref={inlineEditInputRef}
              type="text"
              value={inlineEditPrompt}
              onChange={(e) => setInlineEditPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && inlineEditPrompt.trim()) {
                  e.preventDefault();
                  setPendingDiff(null);
                  void handleInlineEdit();
                }
                if (e.key === 'Escape') {
                  setInlineEditOpen(false);
                  setInlineEditPrompt('');
                  setInlineEditResponse('');
                  setPendingDiff(null);
                  inlineWidgetRef.current?.dispose();
                  inlineWidgetRef.current = null;
                }
                // Arrow up/down for prompt history
                if (e.key === 'ArrowUp' && promptHistory.length > 0) {
                  e.preventDefault();
                  const next = Math.min(historyIndex + 1, promptHistory.length - 1);
                  setHistoryIndex(next);
                  setInlineEditPrompt(promptHistory[next]);
                }
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  if (historyIndex <= 0) {
                    setHistoryIndex(-1);
                    setInlineEditPrompt('');
                  } else {
                    const next = historyIndex - 1;
                    setHistoryIndex(next);
                    setInlineEditPrompt(promptHistory[next]);
                  }
                }
              }}
              placeholder={inlineEditLoading ? 'Thinking…' : '"add error handling" or "explain this"'}
              disabled={inlineEditLoading}
              style={{
                flex: 1,
                padding: '7px 10px',
                borderRadius: 8,
                border: '1px solid rgba(99, 102, 241, 0.15)',
                background: 'rgba(255,255,255,0.7)',
                fontSize: 12,
                color: '#1e293b',
                outline: 'none',
              }}
            />
            {inlineEditLoading ? (
              <div style={{ width: 14, height: 14, border: '2px solid #6366f1', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.6s linear infinite', flexShrink: 0 }} />
            ) : (
              <button
                type="button"
                onClick={() => {
                  setInlineEditOpen(false); setInlineEditPrompt(''); setInlineEditResponse('');
                  inlineWidgetRef.current?.dispose(); inlineWidgetRef.current = null;
                }}
                style={{
                  padding: '4px 6px', border: 'none', background: 'transparent',
                  color: '#94a3b8', fontSize: 10, cursor: 'pointer', fontWeight: 500,
                }}
              >
                esc
              </button>
            )}
          </div>

          {/* Response area (explain mode or error) */}
          {/* Response area (explain mode or error) */}
          {inlineEditResponse ? (
            <div style={{
              padding: '8px 10px',
              borderRadius: 8,
              background: inlineEditResponse.startsWith('Error')
                ? 'rgba(239,68,68,0.06)'
                : 'rgba(99,102,241,0.04)',
              border: `1px solid ${inlineEditResponse.startsWith('Error') ? 'rgba(239,68,68,0.15)' : 'rgba(99,102,241,0.1)'}`,
              fontSize: 11,
              lineHeight: 1.5,
              color: inlineEditResponse.startsWith('Error') ? '#dc2626' : '#334155',
              maxHeight: 120,
              overflowY: 'auto',
              whiteSpace: 'pre-wrap',
            }}>
              {inlineEditResponse}
            </div>
          ) : null}

          {/* Diff preview + Accept/Reject */}
          {pendingDiff ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{
                maxHeight: 160,
                overflowY: 'auto',
                borderRadius: 8,
                border: '1px solid rgba(99,102,241,0.1)',
                fontSize: 11,
                fontFamily: '"SF Mono", "Menlo", ui-monospace, monospace',
                lineHeight: 1.6,
              }}>
                {(() => {
                  const origLines = pendingDiff.original.split('\n');
                  const modLines = pendingDiff.modified.split('\n');
                  const maxLen = Math.max(origLines.length, modLines.length);
                  const diffLines: Array<{ text: string; type: 'same' | 'add' | 'remove' }> = [];
                  for (let i = 0; i < maxLen; i++) {
                    const orig = origLines[i] ?? '';
                    const mod = modLines[i] ?? '';
                    if (i >= origLines.length) {
                      diffLines.push({ text: mod, type: 'add' });
                    } else if (i >= modLines.length) {
                      diffLines.push({ text: orig, type: 'remove' });
                    } else if (orig !== mod) {
                      diffLines.push({ text: orig, type: 'remove' });
                      diffLines.push({ text: mod, type: 'add' });
                    } else {
                      diffLines.push({ text: orig, type: 'same' });
                    }
                  }
                  return diffLines.map((line, i) => (
                    <div key={i} style={{
                      padding: '0 8px',
                      background: line.type === 'add' ? 'rgba(34,197,94,0.08)'
                        : line.type === 'remove' ? 'rgba(239,68,68,0.06)'
                        : 'transparent',
                      color: line.type === 'add' ? '#16a34a'
                        : line.type === 'remove' ? '#dc2626'
                        : '#64748b',
                      textDecoration: line.type === 'remove' ? 'line-through' : 'none',
                      opacity: line.type === 'remove' ? 0.7 : 1,
                    }}>
                      <span style={{ display: 'inline-block', width: 14, color: '#94a3b8', userSelect: 'none' }}>
                        {line.type === 'add' ? '+' : line.type === 'remove' ? '−' : ' '}
                      </span>
                      {line.text || ' '}
                    </div>
                  ));
                })()}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  onClick={handleAcceptDiff}
                  style={{
                    flex: 1, padding: '6px 0', borderRadius: 8,
                    border: '1px solid rgba(34,197,94,0.3)',
                    background: 'rgba(34,197,94,0.06)',
                    color: '#16a34a', fontSize: 11, fontWeight: 600, cursor: 'pointer',
                  }}
                >
                  ✓ Accept
                </button>
                <button
                  type="button"
                  onClick={handleRejectDiff}
                  style={{
                    flex: 1, padding: '6px 0', borderRadius: 8,
                    border: '1px solid rgba(239,68,68,0.2)',
                    background: 'transparent',
                    color: '#dc2626', fontSize: 11, fontWeight: 500, cursor: 'pointer',
                  }}
                >
                  ✗ Reject
                </button>
              </div>
            </div>
          ) : null}
        </div>,
        inlineWidgetDomRef.current,
      )}

      {/* Body */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {activeView === 'diff' && hasDiff && !editing ? (
          <div style={{ height: '100%', overflowY: 'auto' }}>
            <pre style={{
              margin: 0,
              paddingTop: 14,
              paddingRight: 16,
              paddingBottom: 14,
              paddingLeft: 16,
              fontSize: '0.8rem',
              lineHeight: 1.65,
              fontFamily: '"SF Mono", "Menlo", ui-monospace, monospace',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: 'var(--t-text-strong)',
            }}>
              {renderDiffLines(diff)}
            </pre>
          </div>
        ) : content !== null ? (
          <MonacoEditor
            height="100%"
            language={getMonacoLanguage(filePath)}
            value={editContent}
            theme={themeId === 'dark' ? 'cortex-graphite' : 'cortex-frost'}
            onChange={(value) => {
              if (editing && value !== undefined) {
                setEditContent(value);
                setDirty(value !== content);
              }
            }}
            onMount={handleEditorMount}
            beforeMount={defineCortexMonacoThemes}
            options={{
              readOnly: false,
              fontSize: 13,
              fontFamily: '"SF Mono", "Menlo", "Monaco", "Cascadia Code", ui-monospace, monospace',
              lineHeight: 20,
              tabSize: 2,
              insertSpaces: true,
              minimap: { enabled: true, maxColumn: 80, scale: 2 },
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              lineNumbers: 'on',
              glyphMargin: false,
              folding: true,
              bracketPairColorization: { enabled: true },
              renderLineHighlight: 'line',
              occurrencesHighlight: 'singleFile',
              matchBrackets: 'always',
              smoothScrolling: true,
              cursorBlinking: 'smooth',
              cursorSmoothCaretAnimation: 'on',
              padding: { top: 12, bottom: 12 },
              overviewRulerLanes: 0,
              hideCursorInOverviewRuler: true,
              overviewRulerBorder: false,
              scrollbar: {
                verticalScrollbarSize: 8,
                horizontalScrollbarSize: 8,
                useShadows: false,
              },
              contextmenu: true,
              quickSuggestions: false,
              suggestOnTriggerCharacters: false,
              parameterHints: { enabled: false },
              inlineSuggest: { enabled: false }, // re-enable when tab autocomplete is stabilized
              renderWhitespace: 'selection',
              guides: { bracketPairs: true, indentation: true },
            }}
          />
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: 'var(--t-text-muted)' }}>
            Could not load file content
          </div>
        )}
      </div>
    </div>
  );
});

// ── Port Preview (reuses /api/panel/proxy) ──

function PortPreview({ url, port, repo }: { url: string; port: number; repo?: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const normalizedUrl = url.replace('0.0.0.0', 'localhost');
  const proxiedSrc = `/api/panel/proxy?url=${encodeURIComponent(normalizedUrl)}`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#fff' }}>
      {/* Toolbar — matches TerminalWorkspace PreviewToolbar pattern */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        height: 32,
        paddingLeft: 12,
        paddingRight: 8,
        background: '#f1f5f9',
        borderBottom: '1px solid #e2e8f0',
        gap: 8,
        flexShrink: 0,
      }}>
        {/* Green dot — live */}
        <span style={{
          width: 8, height: 8, borderRadius: '50%',
          background: '#22c55e', flexShrink: 0,
        }} />
        {/* URL */}
        <span style={{
          fontSize: 11,
          color: '#64748b',
          fontFamily: 'ui-monospace, "SF Mono", Monaco, Menlo, monospace',
          flex: 1,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {normalizedUrl}
        </span>
        {repo ? (
          <span style={{
            fontSize: 9, fontWeight: 600,
            color: '#94a3b8',
            padding: '1px 5px', borderRadius: 4,
            background: 'rgba(148,163,184,0.1)',
          }}>
            {repo}
          </span>
        ) : null}
        {/* Refresh */}
        <button
          type="button"
          onClick={() => {
            const iframe = iframeRef.current;
            if (iframe) {
              const src = iframe.src;
              iframe.src = '';
              setTimeout(() => { iframe.src = src; }, 50);
            }
            setRefreshKey(k => k + 1);
          }}
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 24, height: 24, borderRadius: 6,
            border: '1px solid rgba(148,163,184,0.18)',
            background: 'rgba(255,255,255,0.82)',
            color: '#475569', cursor: 'pointer', flexShrink: 0,
          }}
          title="Refresh preview"
        >
          <RefreshCw size={12} strokeWidth={2} />
        </button>
        {/* Open in browser */}
        <button
          type="button"
          onClick={() => window.open(normalizedUrl, '_blank')}
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 24, height: 24, borderRadius: 6,
            border: '1px solid rgba(148,163,184,0.18)',
            background: 'rgba(255,255,255,0.82)',
            color: '#475569', cursor: 'pointer', flexShrink: 0,
          }}
          title="Open in browser"
        >
          <ExternalLink size={12} strokeWidth={2} />
        </button>
      </div>
      {/* Iframe — proxied through /api/panel/proxy */}
      <iframe
        key={refreshKey}
        ref={iframeRef}
        src={proxiedSrc}
        title={`Preview localhost:${port}`}
        style={{
          flex: 1, border: 'none', width: '100%', background: '#ffffff',
        }}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      />
    </div>
  );
}

// ── Empty State ──

function CanvasEmpty() {
  return (
    <div style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      minHeight: 200,
    }}>
      <div style={{ fontSize: 36, marginBottom: 12, opacity: 0.1, color: 'var(--t-text-muted)' }}>◇</div>
      <p style={{
        fontSize: 13,
        color: 'var(--t-text-faint)',
        letterSpacing: '-0.01em',
      }}>
        Select an issue, agent, or file to open here
      </p>
    </div>
  );
}

// ── Git Log Viewer ──

interface GitLogCommit {
  hash: string;
  shortHash: string;
  author: string;
  authorEmail: string;
  date: string;
  subject: string;
  refs: { type: string; name: string }[];
}

function GitLogViewer({ workspace, onSelectCommit }: { workspace: string; onSelectCommit?: (hash: string, meta?: Record<string, string>) => void }) {
  const [commits, setCommits] = useState<GitLogCommit[]>([]);
  const [currentBranch, setCurrentBranch] = useState('main');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const wsParam = workspace ? `?workspace=${encodeURIComponent(workspace)}` : '';
    fetch(`/api/panel/git-log${wsParam}`)
      .then(r => r.json())
      .then(data => {
        if (!cancelled) {
          setCommits(data.commits ?? []);
          setCurrentBranch(data.currentBranch ?? 'main');
          setLoading(false);
        }
      })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [workspace]);

  if (loading) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: 'var(--t-text-muted)' }}>Loading git log…</div>;
  }

  if (commits.length === 0) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: 'var(--t-text-muted)' }}>No commits found</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{
        paddingTop: 12,
        paddingRight: 20,
        paddingBottom: 10,
        paddingLeft: 20,
        borderBottom: '1px solid var(--t-divider)',
        background: 'var(--t-panel-translucent)',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}>
        <GitCommit size={16} strokeWidth={1.8} style={{ color: 'var(--t-text-secondary)' }} />
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--t-text)' }}>Git History</span>
        <span style={{
          fontSize: 11,
          fontFamily: '"SF Mono", ui-monospace, monospace',
          paddingTop: 2,
          paddingRight: 8,
          paddingBottom: 2,
          paddingLeft: 8,
          borderRadius: 99,
          background: 'rgba(59,130,246,0.08)',
          color: '#3b82f6',
          fontWeight: 600,
        }}>{currentBranch}</span>
        <span style={{ fontSize: 11, color: 'var(--t-text-muted)', marginLeft: 'auto' }}>{commits.length} commits</span>
      </div>

      {/* Commit list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {commits.map((commit, i) => (
          <button
            key={commit.hash}
            type="button"
            onClick={() => onSelectCommit?.(commit.hash, workspace ? { workspace } : undefined)}
            style={{
              display: 'flex',
              gap: 12,
              width: '100%',
              paddingTop: 10,
              paddingRight: 20,
              paddingBottom: 10,
              paddingLeft: 20,
              border: 'none',
              borderBottom: '1px solid var(--t-divider-subtle)',
              background: 'transparent',
              cursor: 'pointer',
              textAlign: 'left',
              fontFamily: '-apple-system, system-ui, sans-serif',
              transition: 'background 80ms ease',
              position: 'relative',
            }}
          >
            {/* Graph line */}
            <div style={{
              width: 20,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              flexShrink: 0,
              position: 'relative',
            }}>
              {i > 0 ? (
                <div style={{
                  position: 'absolute',
                  top: 0,
                  width: 2,
                  height: 10,
                  background: 'var(--t-divider)',
                }} />
              ) : null}
              <div style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                background: commit.refs.some(r => r.type === 'head') ? '#3b82f6' : 'var(--t-text-faint)',
                border: commit.refs.some(r => r.type === 'head') ? '2px solid rgba(59,130,246,0.3)' : '2px solid var(--t-divider-subtle)',
                marginTop: 6,
                flexShrink: 0,
                zIndex: 1,
              }} />
              {i < commits.length - 1 ? (
                <div style={{
                  width: 2,
                  flex: 1,
                  background: 'var(--t-divider)',
                  marginTop: 2,
                }} />
              ) : null}
            </div>

            {/* Content */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{
                  fontSize: 13,
                  fontWeight: 400,
                  color: 'var(--t-text-strong)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  flex: 1,
                  minWidth: 0,
                }}>{commit.subject}</span>

                {/* Ref badges */}
                {commit.refs.map((ref, j) => (
                  <span key={j} style={{
                    fontSize: 10,
                    fontWeight: 600,
                    paddingTop: 1,
                    paddingRight: 6,
                    paddingBottom: 1,
                    paddingLeft: 6,
                    borderRadius: 4,
                    flexShrink: 0,
                    ...(ref.type === 'head'
                      ? { color: '#3b82f6', background: 'rgba(59,130,246,0.08)' }
                      : ref.type === 'tag'
                        ? { color: '#f59e0b', background: 'rgba(245,158,11,0.08)' }
                        : { color: 'var(--t-text-muted)', background: 'var(--t-hover)' }
                    ),
                    fontFamily: '"SF Mono", ui-monospace, monospace',
                  }}>
                    {ref.name}
                  </span>
                ))}
              </div>

              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginTop: 3,
                fontSize: 11,
                color: 'var(--t-text-muted)',
              }}>
                <span style={{
                  fontFamily: '"SF Mono", ui-monospace, monospace',
                  fontSize: 11,
                  color: 'var(--t-text-secondary)',
                  fontWeight: 500,
                }}>{commit.shortHash}</span>
                <span>{commit.author}</span>
                <span>·</span>
                <span>{formatAge(commit.date)}</span>
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Image Preview ──

function ImagePreview({ filePath, workspace }: { filePath: string; workspace?: string }) {
  const [imageData, setImageData] = useState<{ type: string; dataUrl?: string; content?: string; mimeType: string; size: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const wsParam = workspace ? `&workspace=${encodeURIComponent(workspace)}` : '';
    fetch(`/api/panel/file-preview?path=${encodeURIComponent(filePath)}${wsParam}`)
      .then(r => r.json())
      .then(data => {
        if (!cancelled) {
          if (data.error) {
            setError(data.error);
          } else {
            setImageData(data);
          }
          setLoading(false);
        }
      })
      .catch(() => { if (!cancelled) { setError('Failed to load image'); setLoading(false); } });
    return () => { cancelled = true; };
  }, [filePath, workspace]);

  const fileName = filePath.split('/').pop() ?? filePath;

  if (loading) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: 'var(--t-text-muted)' }}>Loading image…</div>;
  }

  if (error || !imageData) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: '#ef4444' }}>{error || 'Could not load image'}</div>;
  }

  const sizeLabel = imageData.size < 1024
    ? `${imageData.size} B`
    : imageData.size < 1024 * 1024
      ? `${(imageData.size / 1024).toFixed(1)} KB`
      : `${(imageData.size / (1024 * 1024)).toFixed(1)} MB`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{
        paddingTop: 12,
        paddingRight: 20,
        paddingBottom: 10,
        paddingLeft: 20,
        borderBottom: '1px solid var(--t-divider)',
        background: 'var(--t-panel-translucent)',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}>
        <FileText size={16} strokeWidth={1.8} style={{ color: 'var(--t-text-muted)' }} />
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--t-text)' }}>{fileName}</span>
        <span style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>{imageData.mimeType} · {sizeLabel}</span>
      </div>

      {/* Image */}
      <div style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'auto',
        padding: 24,
        background: 'repeating-conic-gradient(rgba(0,0,0,0.04) 0% 25%, transparent 0% 50%) 50% / 16px 16px',
      }}>
        {imageData.type === 'svg' && imageData.content ? (
          <div
            dangerouslySetInnerHTML={{ __html: imageData.content }}
            style={{ maxWidth: '100%', maxHeight: '100%' }}
          />
        ) : imageData.dataUrl ? (
          <img
            src={imageData.dataUrl}
            alt={fileName}
            style={{
              maxWidth: '100%',
              maxHeight: '100%',
              objectFit: 'contain',
              borderRadius: 4,
              boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

// ── Deploy Viewer ──

interface VercelDeploy {
  uid: string;
  name: string;
  url: string;
  state: string;
  created: number;
  ready?: number;
  meta?: {
    githubCommitSha?: string;
    githubCommitMessage?: string;
    githubCommitRef?: string;
    githubCommitAuthorLogin?: string;
  };
  target?: string;
  inspectorUrl?: string;
}

function deployColor(state: string): string {
  switch (state.toUpperCase()) {
    case 'READY': return '#22c55e';
    case 'BUILDING': case 'INITIALIZING': return '#f59e0b';
    case 'ERROR': case 'CANCELED': return '#ef4444';
    case 'QUEUED': return '#94a3b8';
    default: return '#64748b';
  }
}

function deployIcon(state: string): string {
  switch (state.toUpperCase()) {
    case 'READY': return '●';
    case 'BUILDING': case 'INITIALIZING': return '◉';
    case 'ERROR': return '✗';
    case 'CANCELED': return '⊘';
    case 'QUEUED': return '○';
    default: return '○';
  }
}

function DeployViewer({ project }: { project?: string }) {
  const [deploys, setDeploys] = useState<VercelDeploy[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = project ? `?project=${encodeURIComponent(project)}` : '';
    fetch(`/api/panel/deployments${params}`)
      .then(r => r.json())
      .then(data => {
        if (!cancelled) {
          setDeploys(data.deployments ?? []);
          setLoading(false);
        }
      })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [project]);

  if (loading) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: 'var(--t-text-muted)' }}>Loading deployments…</div>;
  }

  if (deploys.length === 0) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: 'var(--t-text-muted)' }}>No deployments found</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{
        paddingTop: 12,
        paddingRight: 20,
        paddingBottom: 10,
        paddingLeft: 20,
        borderBottom: '1px solid var(--t-divider)',
        background: 'var(--t-panel-translucent)',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}>
        <Globe size={16} strokeWidth={1.8} style={{ color: 'var(--t-text-secondary)' }} />
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--t-text)' }}>Deployments</span>
        {project ? (
          <span style={{ fontSize: 11, color: 'var(--t-text-muted)', fontFamily: '"SF Mono", ui-monospace, monospace' }}>{project}</span>
        ) : null}
      </div>

      {/* Deploy list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {deploys.map((d) => {
          const color = deployColor(d.state);
          const icon = deployIcon(d.state);
          const isProduction = d.target === 'production';
          const commitMsg = d.meta?.githubCommitMessage ?? '';
          const commitSha = d.meta?.githubCommitSha?.slice(0, 7) ?? '';
          const branch = d.meta?.githubCommitRef ?? '';
          const author = d.meta?.githubCommitAuthorLogin ?? '';
          const age = formatAge(new Date(d.created).toISOString());

          return (
            <div
              key={d.uid}
              style={{
                display: 'flex',
                gap: 12,
                paddingTop: 12,
                paddingRight: 20,
                paddingBottom: 12,
                paddingLeft: 20,
                borderBottom: '1px solid var(--t-divider-subtle)',
              }}
            >
              {/* Status */}
              <span style={{
                fontSize: 16,
                color,
                fontWeight: 700,
                lineHeight: 1.2,
                flexShrink: 0,
                marginTop: 2,
              }}>{icon}</span>

              <div style={{ flex: 1, minWidth: 0 }}>
                {/* URL + target */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <a
                    href={`https://${d.url}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      fontSize: 13,
                      fontWeight: 500,
                      color: 'var(--t-text-strong)',
                      textDecoration: 'none',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {d.url}
                  </a>
                  {isProduction ? (
                    <span style={{
                      fontSize: 9,
                      fontWeight: 700,
                      paddingTop: 1,
                      paddingRight: 5,
                      paddingBottom: 1,
                      paddingLeft: 5,
                      borderRadius: 3,
                      background: 'rgba(34,197,94,0.08)',
                      color: '#22c55e',
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                    }}>Production</span>
                  ) : null}
                  <span style={{
                    fontSize: 10,
                    paddingTop: 1,
                    paddingRight: 5,
                    paddingBottom: 1,
                    paddingLeft: 5,
                    borderRadius: 3,
                    color,
                    background: `${color}10`,
                    fontWeight: 600,
                  }}>{d.state.toLowerCase()}</span>
                </div>

                {/* Commit info */}
                {commitMsg ? (
                  <div style={{
                    fontSize: 12,
                    color: 'var(--t-text-secondary)',
                    marginTop: 4,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {commitMsg}
                  </div>
                ) : null}

                {/* Meta line */}
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  marginTop: 4,
                  fontSize: 11,
                  color: 'var(--t-text-muted)',
                }}>
                  {branch ? (
                    <span style={{ fontFamily: '"SF Mono", ui-monospace, monospace', fontSize: 10 }}>{branch}</span>
                  ) : null}
                  {commitSha ? (
                    <>
                      <span>·</span>
                      <span style={{ fontFamily: '"SF Mono", ui-monospace, monospace', fontSize: 10, color: 'var(--t-text-secondary)' }}>{commitSha}</span>
                    </>
                  ) : null}
                  {author ? (
                    <>
                      <span>·</span>
                      <span>{author}</span>
                    </>
                  ) : null}
                  <span>·</span>
                  <span>{age}</span>
                  {d.inspectorUrl ? (
                    <>
                      <span>·</span>
                      <a
                        href={d.inspectorUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: '#3b82f6', textDecoration: 'none', fontSize: 10 }}
                      >
                        Inspect ↗
                      </a>
                    </>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── README Viewer ──

function ReadmeViewer({ workspace }: { workspace: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/panel/readme?workspace=${encodeURIComponent(workspace)}`)
      .then(r => r.json())
      .then(data => {
        if (!cancelled) {
          setContent(data.content);
          setLoading(false);
        }
      })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [workspace]);

  if (loading) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: 'var(--t-text-muted)' }}>Loading README…</div>;
  }

  if (!content) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: 'var(--t-text-muted)' }}>No README found in this workspace</div>;
  }

  return (
    <div style={{ padding: '24px 32px', overflowY: 'auto', height: '100%' }}>
      <MarkdownBody text={content} />
    </div>
  );
}

// ── CI Viewer ──

interface CIRun {
  databaseId: number;
  displayTitle: string;
  event: string;
  headBranch: string;
  headSha?: string;
  status: string;
  conclusion: string;
  createdAt: string;
  updatedAt: string;
  workflowName: string;
  url: string;
  pullRequests?: { number: number; url: string }[];
}

interface CIRunDetail extends CIRun {
  jobs: {
    databaseId: number;
    name: string;
    status: string;
    conclusion: string;
    startedAt: string;
    completedAt: string;
    url?: string;
    checkRunId?: number | null;
    annotations?: CIAnnotation[];
  }[];
  annotations: CIAnnotation[];
  botComments: CIBotComment[];
}

interface CIAnnotation {
  path: string;
  startLine: number;
  endLine: number;
  level: string;
  message: string;
  title: string;
  rawDetails: string;
  blobUrl: string;
  jobName?: string;
  jobUrl?: string;
}

interface CIBotComment {
  id: number;
  prNumber: number;
  kind: 'issue' | 'review';
  author: string;
  body: string;
  createdAt: string;
  path?: string;
  line?: number | null;
  url: string;
}

function ciColor(conclusion: string, status: string): string {
  if (status === 'in_progress' || status === 'queued') return '#f59e0b';
  if (conclusion === 'success') return '#22c55e';
  if (conclusion === 'failure') return '#ef4444';
  if (conclusion === 'cancelled') return '#6b7280';
  return '#94a3b8';
}

function ciIcon(conclusion: string, status: string): string {
  if (status === 'in_progress') return '◉';
  if (status === 'queued') return '○';
  if (conclusion === 'success') return '✓';
  if (conclusion === 'failure') return '✗';
  if (conclusion === 'cancelled') return '⊘';
  return '○';
}

function CIViewer({ repo, initialRunId }: { repo?: string; initialRunId?: number }) {
  const [runs, setRuns] = useState<CIRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedRun, setSelectedRun] = useState<number | null>(null);
  const [runDetail, setRunDetail] = useState<CIRunDetail | null>(null);
  const [logs, setLogs] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const repoParam = repo ? `?repo=${encodeURIComponent(repo)}` : '';
    fetch(`/api/panel/ci${repoParam}`)
      .then(r => r.json())
      .then(data => {
        if (!cancelled) {
          const nextRuns = data.runs ?? [];
          setRuns(nextRuns);
          if (typeof initialRunId === 'number') {
            const matchingRun = nextRuns.find((run: CIRun) => run.databaseId === initialRunId);
            setSelectedRun(matchingRun ? initialRunId : null);
          }
          setLoading(false);
        }
      })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [initialRunId, repo]);

  useEffect(() => {
    if (!selectedRun) { setRunDetail(null); setLogs(''); return; }
    let cancelled = false;
    setDetailLoading(true);
    const repoParam = repo ? `?repo=${encodeURIComponent(repo)}` : '';
    fetch(`/api/panel/ci/${selectedRun}${repoParam}`)
      .then(r => r.json())
      .then(data => {
        if (!cancelled) {
          setRunDetail(data.run ?? null);
          setLogs(data.logs ?? '');
          setDetailLoading(false);
        }
      })
      .catch(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [selectedRun, repo]);

  if (loading) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: 'var(--t-text-muted)' }}>Loading CI runs…</div>;
  }

  if (runs.length === 0) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: 'var(--t-text-muted)' }}>No workflow runs found</div>;
  }

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      {/* Run list */}
      <div style={{
        width: 340,
        flexShrink: 0,
        borderRight: '1px solid var(--t-divider)',
        overflowY: 'auto',
        background: 'var(--t-bg-subtle)',
      }}>
        {runs.map((run) => {
          const color = ciColor(run.conclusion, run.status);
          const icon = ciIcon(run.conclusion, run.status);
          const isActive = selectedRun === run.databaseId;
          return (
            <button
              key={run.databaseId}
              type="button"
              onClick={() => setSelectedRun(run.databaseId)}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                width: '100%',
                paddingTop: 10,
                paddingRight: 14,
                paddingBottom: 10,
                paddingLeft: 14,
                border: 'none',
                borderLeft: isActive ? `3px solid ${color}` : '3px solid transparent',
                background: isActive ? 'rgba(37, 99, 235, 0.04)' : 'transparent',
                cursor: 'pointer',
                textAlign: 'left',
                fontFamily: '-apple-system, system-ui, sans-serif',
                borderBottom: '1px solid var(--t-divider-subtle)',
              }}
            >
              <span style={{
                fontSize: 16,
                color,
                fontWeight: 700,
                lineHeight: 1.2,
                flexShrink: 0,
                marginTop: 1,
              }}>{icon}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 13,
                  fontWeight: isActive ? 600 : 400,
                  color: 'var(--t-text-strong)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>{run.displayTitle}</div>
                <div style={{ fontSize: 11, color: 'var(--t-text-muted)', marginTop: 2, display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span style={{ fontFamily: '"SF Mono", ui-monospace, monospace', fontSize: 10 }}>{run.headBranch}</span>
                  <span>·</span>
                  <span>{run.workflowName}</span>
                  <span>·</span>
                  <span>{formatAge(run.createdAt)}</span>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Detail */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {!selectedRun ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: 'var(--t-text-muted)' }}>
            Select a run to view details
          </div>
        ) : detailLoading ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: 'var(--t-text-muted)' }}>
            Loading run details…
          </div>
        ) : runDetail ? (
          <div style={{ paddingTop: 16, paddingRight: 20, paddingBottom: 16, paddingLeft: 20 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--t-text)', marginBottom: 8 }}>
              {runDetail.displayTitle}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--t-text-secondary)', marginBottom: 16 }}>
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                paddingTop: 2,
                paddingRight: 8,
                paddingBottom: 2,
                paddingLeft: 8,
                borderRadius: 99,
                fontSize: 11,
                fontWeight: 600,
                color: ciColor(runDetail.conclusion, runDetail.status),
                background: `${ciColor(runDetail.conclusion, runDetail.status)}12`,
              }}>
                {ciIcon(runDetail.conclusion, runDetail.status)} {runDetail.conclusion || runDetail.status}
              </span>
              <span>{runDetail.workflowName}</span>
              <span>·</span>
              <span style={{ fontFamily: '"SF Mono", ui-monospace, monospace', fontSize: 10 }}>{runDetail.headBranch}</span>
              {runDetail.headSha ? (
                <>
                  <span>·</span>
                  <span style={{ fontFamily: '"SF Mono", ui-monospace, monospace', fontSize: 10 }}>{runDetail.headSha.slice(0, 7)}</span>
                </>
              ) : null}
              <span>·</span>
              <span>{runDetail.event}</span>
            </div>

            {runDetail.pullRequests && runDetail.pullRequests.length > 0 ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t-text-secondary)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                  Related PRs
                </div>
                {runDetail.pullRequests.map((pr) => (
                  <a
                    key={pr.number}
                    href={pr.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: '3px 8px',
                      borderRadius: 99,
                      fontSize: 11,
                      fontWeight: 600,
                      color: '#2563eb',
                      background: 'rgba(37,99,235,0.08)',
                      textDecoration: 'none',
                    }}
                  >
                    <GitPullRequest size={11} strokeWidth={2} />
                    PR #{pr.number}
                  </a>
                ))}
              </div>
            ) : null}

            {/* Jobs */}
            {runDetail.jobs?.length > 0 ? (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--t-text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Jobs
                </div>
                {runDetail.jobs.map((job, i) => {
                  const jColor = ciColor(job.conclusion, job.status);
                  return (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 4 }}>
                      <span style={{ color: jColor, fontWeight: 700 }}>{ciIcon(job.conclusion, job.status)}</span>
                      <span style={{ color: 'var(--t-text-strong)' }}>{job.name}</span>
                      <span style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>{job.conclusion || job.status}</span>
                      {job.annotations && job.annotations.length > 0 ? (
                        <span style={{
                          fontSize: 10,
                          fontWeight: 700,
                          color: '#d97706',
                          padding: '1px 6px',
                          borderRadius: 99,
                          background: 'rgba(217,119,6,0.08)',
                        }}>
                          {job.annotations.length} annotation{job.annotations.length === 1 ? '' : 's'}
                        </span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}

            {runDetail.annotations?.length > 0 ? (
              <div style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--t-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Annotations
                  </div>
                  <span style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>
                    {runDetail.annotations.length} total
                  </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {runDetail.annotations.map((annotation, index) => {
                    const levelColor = annotation.level === 'failure'
                      ? '#dc2626'
                      : annotation.level === 'warning'
                        ? '#d97706'
                        : '#2563eb';
                    const location = annotation.path
                      ? `${annotation.path}${annotation.startLine ? `:${annotation.startLine}${annotation.endLine && annotation.endLine !== annotation.startLine ? `-${annotation.endLine}` : ''}` : ''}`
                      : 'Unknown location';

                    return (
                      <div
                        key={`${annotation.jobName ?? 'job'}:${annotation.path}:${annotation.startLine}:${index}`}
                        style={{
                          padding: '10px 12px',
                          borderRadius: 10,
                          border: '1px solid var(--t-divider-subtle)',
                          background: 'var(--t-hover)',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                          <span style={{
                            fontSize: 10,
                            fontWeight: 700,
                            color: levelColor,
                            textTransform: 'uppercase',
                            letterSpacing: '0.05em',
                          }}>
                            {annotation.level}
                          </span>
                          {annotation.jobName ? (
                            <span style={{ fontSize: 11, color: 'var(--t-text-secondary)', fontWeight: 600 }}>
                              {annotation.jobName}
                            </span>
                          ) : null}
                          <span style={{ fontSize: 11, color: 'var(--t-text-muted)', fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                            {location}
                          </span>
                          {annotation.blobUrl ? (
                            <a
                              href={annotation.blobUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{
                                marginLeft: 'auto',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 4,
                                fontSize: 11,
                                color: 'var(--t-text-secondary)',
                                textDecoration: 'none',
                              }}
                            >
                              <ExternalLink size={11} />
                              Source
                            </a>
                          ) : null}
                        </div>
                        {annotation.title ? (
                          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text-strong)', marginBottom: 4 }}>
                            {annotation.title}
                          </div>
                        ) : null}
                        <div style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--t-text)' }}>
                          {annotation.message}
                        </div>
                        {annotation.rawDetails ? (
                          <div style={{
                            marginTop: 6,
                            fontSize: 11,
                            lineHeight: 1.5,
                            color: 'var(--t-text-muted)',
                            fontFamily: '"SF Mono", ui-monospace, monospace',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                          }}>
                            {annotation.rawDetails}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {runDetail.botComments?.length > 0 ? (
              <div style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--t-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Related Bot Comments
                  </div>
                  <span style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>
                    {runDetail.botComments.length} found
                  </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {runDetail.botComments.map((comment) => (
                    <div
                      key={`${comment.kind}:${comment.id}`}
                      style={{
                        padding: '10px 12px',
                        borderRadius: 10,
                        border: '1px solid var(--t-divider-subtle)',
                        background: 'var(--t-panel-translucent)',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--t-text-strong)' }}>{comment.author}</span>
                        <span style={{
                          fontSize: 10,
                          fontWeight: 700,
                          color: comment.kind === 'review' ? '#8b5cf6' : '#2563eb',
                          textTransform: 'uppercase',
                          letterSpacing: '0.05em',
                        }}>
                          {comment.kind === 'review' ? 'review' : 'comment'}
                        </span>
                        <span style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>
                          PR #{comment.prNumber}
                        </span>
                        {comment.path ? (
                          <span style={{ fontSize: 11, color: 'var(--t-text-muted)', fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                            {comment.path}{comment.line ? `:${comment.line}` : ''}
                          </span>
                        ) : null}
                        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--t-text-muted)' }}>
                          {formatAge(comment.createdAt)}
                        </span>
                      </div>
                      <div style={{ fontSize: 12, lineHeight: 1.6 }}>
                        <MarkdownBody text={comment.body} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {/* Logs */}
            {logs ? (
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--t-text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Logs
                </div>
                <pre style={{
                  margin: 0,
                  padding: 14,
                  fontSize: '0.75rem',
                  lineHeight: 1.5,
                  fontFamily: '"SF Mono", "Menlo", ui-monospace, monospace',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  color: 'var(--t-text-strong)',
                  background: 'var(--t-hover)',
                  borderRadius: 8,
                  border: '1px solid var(--t-divider)',
                  maxHeight: 500,
                  overflowY: 'auto',
                }}>
                  {logs}
                </pre>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ── PR Viewer ──

interface PRDetail {
  number: number;
  title: string;
  body: string;
  state: string;
  author: { login: string };
  headRefName: string;
  baseRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  mergedBy: { login: string } | null;
  labels: { name: string; color: string }[];
  reviews: { author: { login: string }; state: string; body: string }[];
  files: { path: string; additions: number; deletions: number }[];
  statusCheckRollup: {
    name: string;
    status: string;
    conclusion: string;
    detailsUrl?: string;
    startedAt?: string;
    completedAt?: string;
  }[];
  reviewComments: { id: number; body: string; user: string; path: string; line: number | null; created_at: string }[];
  issueComments: { id: number; body: string; user: string; created_at: string }[];
  diffStat: string;
  url: string;
  readiness?: RepoReadiness | null;
  workflowStage?: WorkflowStageBadge | null;
}

function normalizePRDetail(pr: PRDetail): PRDetail {
  return {
    ...pr,
    labels: Array.isArray(pr.labels) ? pr.labels : [],
    reviews: Array.isArray(pr.reviews) ? pr.reviews : [],
    files: Array.isArray(pr.files) ? pr.files : [],
    statusCheckRollup: Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [],
    reviewComments: Array.isArray(pr.reviewComments) ? pr.reviewComments : [],
    issueComments: Array.isArray(pr.issueComments) ? pr.issueComments : [],
  };
}

const prStateStyles: Record<string, { color: string; label: string; bg: string }> = {
  OPEN: { color: '#22c55e', label: 'Open', bg: 'rgba(34,197,94,0.08)' },
  MERGED: { color: '#8b5cf6', label: 'Merged', bg: 'rgba(139,92,246,0.08)' },
  CLOSED: { color: '#ef4444', label: 'Closed', bg: 'rgba(239,68,68,0.08)' },
};

function createDesktopGlassActionStyle(variant: 'primary' | 'muted' = 'primary') {
  const isPrimary = variant === 'primary';
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    paddingTop: 5,
    paddingRight: 10,
    paddingBottom: 5,
    paddingLeft: 10,
    borderRadius: 999,
    border: `1px solid ${isPrimary ? 'rgba(96, 165, 250, 0.26)' : 'rgba(148, 163, 184, 0.22)'}`,
    background: isPrimary
      ? 'linear-gradient(180deg, rgba(255,255,255,0.68), rgba(219,234,254,0.46))'
      : 'linear-gradient(180deg, rgba(255,255,255,0.42), rgba(226,232,240,0.24))',
    boxShadow: isPrimary
      ? '0 10px 24px rgba(37, 99, 235, 0.12)'
      : '0 6px 16px rgba(15, 23, 42, 0.06)',
    color: isPrimary ? '#1d4ed8' : '#475569',
    backdropFilter: 'blur(14px) saturate(1.35)',
    WebkitBackdropFilter: 'blur(14px) saturate(1.35)',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: '-apple-system, system-ui, sans-serif',
  } satisfies React.CSSProperties;
}

function DesktopGlassActionChip({
  icon,
  label,
  onClick,
  variant = 'primary',
  disabled = false,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'muted';
  disabled?: boolean;
}) {
  const style = createDesktopGlassActionStyle(variant);

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      disabled={disabled}
      style={{
        ...style,
        opacity: disabled ? 0.62 : 1,
        cursor: disabled ? 'default' : style.cursor,
      }}
    >
      {icon}
      {label}
    </button>
  );
}

function PRViewer({
  prNumber,
  repo,
  onInjectChatContext,
}: {
  prNumber: number;
  repo?: string;
  onInjectChatContext?: (payload: AgentPanelChatInjectionPayload) => void;
}) {
  const [pr, setPr] = useState<PRDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [activeSection, setActiveSection] = useState<'overview' | 'files' | 'checks' | 'comments' | 'reviews'>('overview');
  const [activeItemIndex, setActiveItemIndex] = useState(0);
  const [reviewComments, setReviewComments] = useState<{
    id: number; author: string; body: string; path: string;
    line: number | null; createdAt: string; diffHunk: string; inReplyTo: number | null;
  }[]>([]);
  const [reviewsLoading, setReviewsLoading] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [addedContextKeys, setAddedContextKeys] = useState<Record<string, true>>({});
  const [hiddenCommentKeys, setHiddenCommentKeys] = useState<Record<string, true>>({});
  const commentInputRef = useRef<HTMLInputElement>(null);
  const [localRepo, setLocalRepo] = useState<Pick<RepoRegistryEntry, 'name' | 'localPath' | 'readiness'> | null>(null);

  const submitAction = useCallback(async (action: string, comment?: string) => {
    setActionLoading(action);
    setActionResult(null);
    try {
      const res = await fetch(`/api/panel/prs/${prNumber}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, repo, comment }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed');
      const labels: Record<string, string> = {
        approved: 'PR approved',
        changes_requested: 'Changes requested',
        commented: 'Comment posted',
        merged: 'PR merged',
        closed: 'PR closed',
      };
      setActionResult({ type: 'success', message: labels[data.action] || 'Done' });
      setCommentText('');
      // Refresh PR data
      const repoParam = repo ? `?repo=${encodeURIComponent(repo)}` : '';
      const fresh = await fetch(`/api/panel/prs/${prNumber}${repoParam}`);
      if (fresh.ok) {
        const freshData = await fresh.json();
        setPr(normalizePRDetail(freshData.pr));
      }
    } catch (err) {
      setActionResult({ type: 'error', message: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setActionLoading(null);
    }
  }, [prNumber, repo]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setActionResult(null);
    setReviewComments([]);

    const repoParam = repo ? `?repo=${encodeURIComponent(repo)}` : '';
    fetch(`/api/panel/prs/${prNumber}${repoParam}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (!cancelled) {
          setPr(normalizePRDetail(data.pr));
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message);
          setLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [prNumber, repo, reloadNonce]);

  useEffect(() => {
    if (!repo) {
      setLocalRepo(null);
      return;
    }
    let cancelled = false;
    fetch('/api/panel/repos')
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const match = (data.repos ?? []).find((entry: RepoRegistryEntry) => repoSlugFromRemote(entry.remoteUrl) === repo);
        setLocalRepo(match ? { name: match.name, localPath: match.localPath, readiness: match.readiness } : null);
      })
      .catch(() => {
        if (!cancelled) setLocalRepo(null);
      });
    return () => { cancelled = true; };
  }, [repo]);

  // Fetch review comments when tab is activated
  useEffect(() => {
    if (activeSection !== 'reviews' || reviewComments.length > 0) return;
    let cancelled = false;
    setReviewsLoading(true);
    const repoParam = repo ? `?repo=${encodeURIComponent(repo)}` : '';
    fetch(`/api/panel/prs/${prNumber}/comments${repoParam}`)
      .then(r => r.json())
      .then(data => {
        if (!cancelled) {
          setReviewComments(data.comments ?? []);
          setReviewsLoading(false);
        }
      })
      .catch(() => { if (!cancelled) setReviewsLoading(false); });
    return () => { cancelled = true; };
  }, [activeSection, prNumber, repo, reviewComments.length]);

  const injectPayload = useCallback((key: string, payload: AgentPanelChatInjectionPayload) => {
    if (!onInjectChatContext) return;
    onInjectChatContext(payload);
    setAddedContextKeys((current) => ({ ...current, [key]: true }));
  }, [onInjectChatContext]);

  const hideComment = useCallback((key: string) => {
    setHiddenCommentKeys((current) => ({ ...current, [key]: true }));
  }, []);

  const focusCommentComposer = useCallback(() => {
    setActiveSection('comments');
    requestAnimationFrame(() => {
      commentInputRef.current?.focus();
      commentInputRef.current?.select();
    });
  }, []);

  const openPullRequestOnGitHub = useCallback(() => {
    if (!repo) return;
    window.open(`https://github.com/${repo}/pull/${prNumber}`, '_blank', 'noopener,noreferrer');
  }, [prNumber, repo]);
  const checkContextKey = useCallback((name?: string | null) => `check:${name ?? 'unknown'}`, []);

  const currentChecks = pr?.statusCheckRollup ?? [];
  const currentAllComments = pr
    ? [
        ...pr.issueComments.map((comment) => ({ ...comment, kind: 'comment' as const })),
        ...pr.reviewComments.map((comment) => ({ ...comment, kind: 'review' as const })),
      ].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    : [];
  const currentVisibleComments = currentAllComments.filter((comment) => !hiddenCommentKeys[`${comment.kind}:${comment.id}`]);
  const currentVisibleReviewComments = reviewComments.filter((comment) => !hiddenCommentKeys[`review-thread:${comment.id}`]);
  const activeSectionItemCount = activeSection === 'files'
    ? (pr?.files?.length ?? 0)
    : activeSection === 'checks'
      ? currentChecks.length
      : activeSection === 'comments'
        ? currentVisibleComments.length
        : activeSection === 'reviews'
          ? currentVisibleReviewComments.length
          : 0;

  useEffect(() => {
    setActiveItemIndex(0);
  }, [activeSection]);

  useEffect(() => {
    setActiveItemIndex((current) => Math.min(current, Math.max(0, activeSectionItemCount - 1)));
  }, [activeSectionItemCount]);

  useEffect(() => {
    if (activeSection === 'overview' || activeSectionItemCount === 0) return undefined;

    const frame = requestAnimationFrame(() => {
      const target = document.querySelector(
        `[data-pr-section="${activeSection}"][data-pr-index="${activeItemIndex}"]`,
      ) as HTMLElement | null;
      target?.scrollIntoView({ block: 'nearest' });
    });

    return () => cancelAnimationFrame(frame);
  }, [activeItemIndex, activeSection, activeSectionItemCount]);

  const runSelectedItemAction = useCallback(async () => {
    if (!pr) return;

    if (activeSection === 'files') {
      const selectedFile = pr.files?.[activeItemIndex];
      if (!selectedFile) return;
      await navigator.clipboard.writeText(selectedFile.path);
      setActionResult({ type: 'success', message: `Copied ${selectedFile.path}` });
      return;
    }

    if (activeSection === 'checks') {
      const selectedCheck = currentChecks[activeItemIndex];
      if (!selectedCheck) return;
      if (selectedCheck.detailsUrl) {
        window.open(selectedCheck.detailsUrl, '_blank', 'noopener,noreferrer');
        return;
      }
      if (!onInjectChatContext) {
        setActionResult({ type: 'error', message: 'No quick action is available for this check here.' });
        return;
      }
      const checkName = selectedCheck.name || 'Unknown check';
      const injectionKey = checkContextKey(selectedCheck.name);
      if (addedContextKeys[injectionKey]) {
        setActionResult({ type: 'success', message: `${checkName} is already in chat.` });
        return;
      }
      injectPayload(
        injectionKey,
        formatCiCheckInjection({
          prNumber: pr.number,
          repo,
          name: checkName,
          status: selectedCheck.status,
          conclusion: selectedCheck.conclusion,
          detailsUrl: selectedCheck.detailsUrl,
          startedAt: selectedCheck.startedAt,
          completedAt: selectedCheck.completedAt,
        }),
      );
      setActionResult({ type: 'success', message: `Added ${checkName} to chat.` });
      return;
    }

    if (activeSection === 'comments') {
      const selectedComment = currentVisibleComments[activeItemIndex];
      if (!selectedComment) return;
      if (!onInjectChatContext) {
        setActionResult({ type: 'error', message: 'Chat injection is unavailable from this surface.' });
        return;
      }
      const commentKey = `${selectedComment.kind}:${selectedComment.id}`;
      if (addedContextKeys[commentKey]) {
        setActionResult({ type: 'success', message: 'That comment is already in chat.' });
        return;
      }
      injectPayload(
        commentKey,
        formatReviewCommentInjection({
          prNumber: pr.number,
          repo,
          author: selectedComment.user,
          body: selectedComment.body,
          createdAt: selectedComment.created_at,
          path: selectedComment.kind === 'review' ? (selectedComment as { path?: string }).path : undefined,
        }),
      );
      setActionResult({ type: 'success', message: `Added ${selectedComment.user}'s comment to chat.` });
      return;
    }

    if (activeSection === 'reviews') {
      const selectedReviewComment = currentVisibleReviewComments[activeItemIndex];
      if (!selectedReviewComment) return;
      if (!onInjectChatContext) {
        setActionResult({ type: 'error', message: 'Chat injection is unavailable from this surface.' });
        return;
      }
      const reviewKey = `review-thread:${selectedReviewComment.id}`;
      if (addedContextKeys[reviewKey]) {
        setActionResult({ type: 'success', message: 'That review thread is already in chat.' });
        return;
      }
      injectPayload(
        reviewKey,
        formatReviewCommentInjection({
          prNumber: pr.number,
          repo,
          author: selectedReviewComment.author,
          body: selectedReviewComment.body,
          createdAt: selectedReviewComment.createdAt,
          path: selectedReviewComment.path,
          line: selectedReviewComment.line,
        }),
      );
      setActionResult({ type: 'success', message: `Added ${selectedReviewComment.path} to chat.` });
    }
  }, [
    activeItemIndex,
    activeSection,
    addedContextKeys,
    currentChecks,
    currentVisibleComments,
    currentVisibleReviewComments,
    checkContextKey,
    injectPayload,
    onInjectChatContext,
    pr,
    prNumber,
    repo,
  ]);

  useEffect(() => {
    if (!pr) return undefined;

    const orderedSections: Array<'overview' | 'files' | 'checks' | 'comments' | 'reviews'> = ['overview', 'files', 'checks', 'comments', 'reviews'];
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTypingTarget = Boolean(
        target && (
          target.tagName === 'INPUT'
          || target.tagName === 'TEXTAREA'
          || target.isContentEditable
        ),
      );

      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && pr.state === 'OPEN' && commentText.trim()) {
        event.preventDefault();
        void submitAction('comment', commentText);
        return;
      }

      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      if (isTypingTarget) {
        if (event.key === 'Escape' && target === commentInputRef.current) {
          commentInputRef.current?.blur();
        }
        return;
      }

      if (/^[1-5]$/.test(event.key)) {
        const section = orderedSections[Number(event.key) - 1];
        if (section) {
          event.preventDefault();
          setActiveSection(section);
        }
        return;
      }

      if (event.key === '[' || event.key === ']') {
        event.preventDefault();
        const currentIndex = orderedSections.indexOf(activeSection);
        const delta = event.key === '[' ? -1 : 1;
        const nextIndex = Math.min(orderedSections.length - 1, Math.max(0, currentIndex + delta));
        setActiveSection(orderedSections[nextIndex]);
        return;
      }

      if (event.key.toLowerCase() === 'o' && repo) {
        event.preventDefault();
        openPullRequestOnGitHub();
        return;
      }

      if ((event.key.toLowerCase() === 'j' || event.key === 'ArrowDown') && activeSection !== 'overview' && activeSectionItemCount > 0) {
        event.preventDefault();
        setActiveItemIndex((current) => Math.min(activeSectionItemCount - 1, current + 1));
        return;
      }

      if ((event.key.toLowerCase() === 'k' || event.key === 'ArrowUp') && activeSection !== 'overview' && activeSectionItemCount > 0) {
        event.preventDefault();
        setActiveItemIndex((current) => Math.max(0, current - 1));
        return;
      }

      if (event.key === 'Enter' && activeSection !== 'overview' && activeSectionItemCount > 0) {
        event.preventDefault();
        void runSelectedItemAction();
        return;
      }

      if (pr.state !== 'OPEN') return;

      if (event.key.toLowerCase() === 'c') {
        event.preventDefault();
        focusCommentComposer();
        return;
      }

      if (actionLoading !== null) return;

      if (event.key.toLowerCase() === 'a') {
        event.preventDefault();
        void submitAction('approve', commentText || undefined);
        return;
      }

      if (event.key.toLowerCase() === 'r') {
        event.preventDefault();
        if (!commentText.trim()) {
          focusCommentComposer();
          return;
        }
        void submitAction('request-changes', commentText);
        return;
      }

      if (event.key.toLowerCase() === 'm') {
        event.preventDefault();
        void submitAction('merge');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    activeSection,
    activeSectionItemCount,
    actionLoading,
    commentText,
    focusCommentComposer,
    openPullRequestOnGitHub,
    pr,
    repo,
    runSelectedItemAction,
    submitAction,
  ]);

  if (loading) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: 'var(--t-text-muted)' }}>Loading PR…</div>;
  }

  if (error || !pr) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 14,
        height: '100%',
        padding: 24,
        textAlign: 'center',
      }}>
        <div style={{ fontSize: 13, color: '#ef4444', lineHeight: 1.5 }}>
          Failed to load PR: {error || 'Unknown'}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
          <button
            type="button"
            onClick={() => setReloadNonce((current) => current + 1)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '8px 12px',
              borderRadius: 10,
              border: '1px solid rgba(37, 99, 235, 0.18)',
              background: 'rgba(37, 99, 235, 0.08)',
              color: '#2563eb',
              fontSize: 12,
              fontWeight: 700,
              cursor: 'pointer',
              fontFamily: '-apple-system, system-ui, sans-serif',
            }}
          >
            <RefreshCw size={12} strokeWidth={2.2} />
            Retry
          </button>
          {repo ? (
            <button
              type="button"
              onClick={() => window.open(`https://github.com/${repo}/pull/${prNumber}`, '_blank', 'noopener,noreferrer')}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '8px 12px',
                borderRadius: 10,
                border: '1px solid rgba(15, 23, 42, 0.1)',
                background: 'var(--t-panel)',
                color: 'var(--t-text)',
                fontSize: 12,
                fontWeight: 700,
                cursor: 'pointer',
                fontFamily: '-apple-system, system-ui, sans-serif',
              }}
            >
              <ExternalLink size={12} strokeWidth={2.2} />
              Open on GitHub
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  const stateStyle = prStateStyles[pr.state] ?? { color: '#6b7280', label: pr.state, bg: 'rgba(0,0,0,0.04)' };
  const allComments = currentAllComments;
  const ciChecks = currentChecks;
  const passedChecks = ciChecks.filter(c => c.conclusion === 'SUCCESS' || c.conclusion === 'success').length;

  const sections: { id: 'overview' | 'files' | 'checks' | 'comments' | 'reviews'; label: string; count?: number; shortcut: string }[] = [
    { id: 'overview', label: 'Overview', shortcut: '1' },
    { id: 'files', label: 'Files', count: pr.changedFiles, shortcut: '2' },
    { id: 'checks', label: 'Checks', count: ciChecks.length, shortcut: '3' },
    { id: 'comments', label: 'Comments', count: allComments.length, shortcut: '4' },
    { id: 'reviews', label: 'Reviews', shortcut: '5' },
  ];
  const visibleComments = currentVisibleComments;
  const visibleReviewComments = currentVisibleReviewComments;
  const failedChecks = ciChecks.filter((check) => check.conclusion && check.conclusion.toLowerCase() !== 'success');
  const pendingChecks = ciChecks.filter((check) => !check.conclusion || check.status?.toLowerCase() !== 'completed');
  const reviews = pr.reviews ?? [];
  const requestedChangesCount = reviews.filter((review) => review.state?.toLowerCase() === 'changes_requested').length;
  const approvedCount = reviews.filter((review) => review.state?.toLowerCase() === 'approved').length;
  const reviewStage = deriveWorkflowStage({
    prState: pr.state,
    requestedChanges: requestedChangesCount,
    failedChecks: failedChecks.length,
    pendingChecks: pendingChecks.length,
  });
  const reviewGuidance = describeWorkflowStage({
    stage: reviewStage,
    prState: pr.state,
    requestedChanges: requestedChangesCount,
    approvedCount,
    failedChecks: failedChecks.length,
    pendingChecks: pendingChecks.length,
  });
  const reviewStatus = reviewStage
    ? {
        label: reviewStage.label,
        detail: reviewGuidance.detail,
        nextAction: reviewGuidance.nextAction,
        tone: reviewStage.key === 'blocked'
          ? { background: 'rgba(239,68,68,0.10)', border: 'rgba(239,68,68,0.18)', color: '#b91c1c' }
          : reviewStage.key === 'waiting'
            ? { background: 'rgba(245,158,11,0.10)', border: 'rgba(245,158,11,0.18)', color: '#b45309' }
            : reviewStage.key === 'merge_ready'
              ? { background: 'rgba(34,197,94,0.10)', border: 'rgba(34,197,94,0.18)', color: '#15803d' }
              : readinessTone(pr.readiness),
      }
    : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{
        paddingTop: 16,
        paddingRight: 20,
        paddingBottom: 12,
        paddingLeft: 20,
        borderBottom: '1px solid var(--t-divider)',
        background: 'var(--t-panel-translucent)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            paddingTop: 3,
            paddingRight: 8,
            paddingBottom: 3,
            paddingLeft: 8,
            borderRadius: 99,
            fontSize: 11,
            fontWeight: 600,
            color: stateStyle.color,
            background: stateStyle.bg,
          }}>
            {stateStyle.label}
          </span>
          <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--t-text)' }}>
            #{pr.number} {pr.title}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 6, fontSize: 12, color: 'var(--t-text-secondary)' }}>
          <span>{pr.author.login}</span>
          <span>wants to merge</span>
          <span style={{
            fontFamily: '"SF Mono", ui-monospace, monospace',
            fontSize: 11,
            paddingTop: 1,
            paddingRight: 5,
            paddingBottom: 1,
            paddingLeft: 5,
            borderRadius: 4,
            background: 'var(--t-divider-subtle)',
          }}>{pr.headRefName}</span>
          <span>→</span>
          <span style={{
            fontFamily: '"SF Mono", ui-monospace, monospace',
            fontSize: 11,
            paddingTop: 1,
            paddingRight: 5,
            paddingBottom: 1,
            paddingLeft: 5,
            borderRadius: 4,
            background: 'var(--t-divider-subtle)',
          }}>{pr.baseRefName}</span>
          <span>·</span>
          <span style={{ color: '#22c55e', fontWeight: 600 }}>+{pr.additions}</span>
          <span style={{ color: '#ef4444', fontWeight: 600 }}>-{pr.deletions}</span>
          <span>·</span>
          <span>{formatAge(pr.createdAt)}</span>
          {reviewStatus ? (
            <>
              <span>·</span>
              <span
                title={reviewStatus.detail}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: '2px 8px',
                  borderRadius: 999,
                  border: `1px solid ${reviewStatus.tone.border}`,
                  background: reviewStatus.tone.background,
                  color: reviewStatus.tone.color,
                  fontSize: 10,
                  fontWeight: 700,
                }}
              >
                {reviewStatus.label}
              </span>
            </>
          ) : null}
        </div>
        {pr.mergedBy ? (
          <div style={{ fontSize: 12, color: '#8b5cf6', marginTop: 4 }}>
            Merged by {pr.mergedBy.login} {pr.mergedAt ? formatAge(pr.mergedAt) : ''}
          </div>
        ) : null}

        {/* Section tabs + actions row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginTop: 10 }}>
          {sections.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setActiveSection(s.id)}
              style={{
                paddingTop: 5,
                paddingRight: 12,
                paddingBottom: 5,
                paddingLeft: 12,
                borderRadius: 8,
                border: 'none',
                fontSize: 12,
                fontWeight: activeSection === s.id ? 600 : 400,
                color: activeSection === s.id ? '#2563eb' : 'var(--t-text-secondary)',
                background: activeSection === s.id ? 'rgba(37,99,235,0.08)' : 'transparent',
                cursor: 'pointer',
                fontFamily: '-apple-system, system-ui, sans-serif',
              }}
              title={`Shortcut ${s.shortcut}`}
            >
              {s.label}{s.count !== undefined ? ` (${s.count})` : ''}
              <span style={{
                marginLeft: 6,
                fontSize: 10,
                fontWeight: 700,
                color: activeSection === s.id ? '#1d4ed8' : 'var(--t-text-faint)',
              }}>
                {s.shortcut}
              </span>
            </button>
          ))}

          {/* Action buttons — only for open PRs */}
          {pr.state === 'OPEN' && (
            <>
              <div style={{ flex: 1 }} />
              <button
                type="button"
                onClick={() => submitAction('approve', commentText || undefined)}
                disabled={actionLoading !== null}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  paddingTop: 5,
                  paddingRight: 10,
                  paddingBottom: 5,
                  paddingLeft: 8,
                  borderRadius: 8,
                  border: '1px solid rgba(34, 197, 94, 0.2)',
                  background: actionLoading === 'approve' ? 'rgba(34,197,94,0.15)' : 'rgba(34,197,94,0.06)',
                  color: '#22c55e',
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: actionLoading ? 'wait' : 'pointer',
                  fontFamily: '-apple-system, system-ui, sans-serif',
                }}
              >
                <Check size={12} strokeWidth={2.5} />
                Approve
                <span style={{ fontSize: 10, opacity: 0.75 }}>A</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!commentText) { setActiveSection('comments'); return; }
                  submitAction('request-changes', commentText);
                }}
                disabled={actionLoading !== null}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  paddingTop: 5,
                  paddingRight: 10,
                  paddingBottom: 5,
                  paddingLeft: 8,
                  borderRadius: 8,
                  border: '1px solid rgba(239, 68, 68, 0.2)',
                  background: actionLoading === 'request-changes' ? 'rgba(239,68,68,0.15)' : 'rgba(239,68,68,0.06)',
                  color: '#ef4444',
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: actionLoading ? 'wait' : 'pointer',
                  fontFamily: '-apple-system, system-ui, sans-serif',
                }}
              >
                <XCircle size={12} strokeWidth={2.5} />
                Changes
                <span style={{ fontSize: 10, opacity: 0.75 }}>R</span>
              </button>
              <button
                type="button"
                onClick={() => submitAction('merge')}
                disabled={actionLoading !== null || !reviewGuidance.mergeAllowed}
                title={!reviewGuidance.mergeAllowed ? reviewGuidance.mergeDetail : 'Merge this pull request'}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  paddingTop: 5,
                  paddingRight: 10,
                  paddingBottom: 5,
                  paddingLeft: 8,
                  borderRadius: 8,
                  border: '1px solid rgba(139, 92, 246, 0.2)',
                  background: actionLoading === 'merge'
                    ? 'rgba(139,92,246,0.15)'
                    : !reviewGuidance.mergeAllowed
                      ? 'rgba(148,163,184,0.12)'
                      : 'rgba(139,92,246,0.06)',
                  color: !reviewGuidance.mergeAllowed ? 'var(--t-text-muted)' : '#8b5cf6',
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: actionLoading ? 'wait' : reviewGuidance.mergeAllowed ? 'pointer' : 'not-allowed',
                  fontFamily: '-apple-system, system-ui, sans-serif',
                  opacity: reviewGuidance.mergeAllowed ? 1 : 0.7,
                }}
              >
                <GitMerge size={12} strokeWidth={2.5} />
                Merge
                <span style={{ fontSize: 10, opacity: 0.75 }}>M</span>
              </button>
            </>
          )}
        </div>

        {/* Action result toast */}
        {actionResult && (
          <div style={{
            marginTop: 6,
            paddingTop: 4,
            paddingRight: 10,
            paddingBottom: 4,
            paddingLeft: 10,
            borderRadius: 6,
            fontSize: 11,
            fontWeight: 500,
            color: actionResult.type === 'success' ? '#22c55e' : '#ef4444',
            background: actionResult.type === 'success' ? 'rgba(34,197,94,0.06)' : 'rgba(239,68,68,0.06)',
          }}>
            {actionResult.message}
          </div>
        )}
      </div>

      {/* Comment compose bar — for open PRs */}
      {pr.state === 'OPEN' && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          paddingTop: 6,
          paddingRight: 20,
          paddingBottom: 6,
          paddingLeft: 20,
          borderBottom: '1px solid var(--t-divider)',
          background: 'var(--t-hover)',
          flexShrink: 0,
        }}>
          <input
            ref={commentInputRef}
            name="reviewComment"
            type="text"
            placeholder="Add a comment… (C focuses, Cmd/Ctrl+Enter sends)"
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            onKeyDown={(e) => {
              if (((e.metaKey || e.ctrlKey) || !e.shiftKey) && e.key === 'Enter' && commentText.trim()) {
                e.preventDefault();
                submitAction('comment', commentText);
              }
            }}
            style={{
              flex: 1,
              border: '1px solid var(--t-divider)',
              borderRadius: 8,
              paddingTop: 6,
              paddingRight: 10,
              paddingBottom: 6,
              paddingLeft: 10,
              fontSize: 12,
              background: 'var(--t-panel)',
              color: 'var(--t-text)',
              outline: 'none',
              fontFamily: '-apple-system, system-ui, sans-serif',
            }}
          />
          <button
            type="button"
            onClick={() => { if (commentText.trim()) submitAction('comment', commentText); }}
            disabled={!commentText.trim() || actionLoading !== null}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              paddingTop: 6,
              paddingRight: 10,
              paddingBottom: 6,
              paddingLeft: 10,
              borderRadius: 8,
              border: 'none',
              background: commentText.trim() ? '#2563eb' : 'var(--t-divider)',
              color: commentText.trim() ? '#fff' : 'var(--t-text-muted)',
              fontSize: 11,
              fontWeight: 600,
              cursor: commentText.trim() ? 'pointer' : 'default',
              fontFamily: '-apple-system, system-ui, sans-serif',
            }}
            >
              <Send size={11} />
              Comment
              <span style={{ fontSize: 10, opacity: 0.8 }}>⌘↵</span>
            </button>
          </div>
        )}

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', paddingTop: 16, paddingRight: 20, paddingBottom: 16, paddingLeft: 20 }}>
        {activeSection === 'overview' ? (
          <div>
            {/* CI Status */}
            {ciChecks.length > 0 ? (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--t-text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  CI Checks ({passedChecks}/{ciChecks.length} passed)
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {ciChecks.map((check, i) => {
                    const passed = check.conclusion === 'SUCCESS' || check.conclusion === 'success';
                    return (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                        <span style={{ color: passed ? '#22c55e' : '#ef4444', fontWeight: 600 }}>
                          {passed ? '✓' : '✗'}
                        </span>
                        <span style={{ color: 'var(--t-text-strong)' }}>{check.name}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {/* Reviews */}
            {reviews.length > 0 ? (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--t-text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Reviews
                </div>
                {reviews.map((review, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginBottom: 4 }}>
                    <span style={{
                      color: review.state === 'APPROVED' ? '#22c55e' : review.state === 'CHANGES_REQUESTED' ? '#ef4444' : '#f59e0b',
                      fontWeight: 600,
                    }}>
                      {review.state === 'APPROVED' ? '✓' : review.state === 'CHANGES_REQUESTED' ? '✗' : '○'}
                    </span>
                    <span style={{ color: 'var(--t-text-strong)' }}>{review.author.login}</span>
                    <span style={{ color: 'var(--t-text-muted)' }}>{review.state.toLowerCase().replace('_', ' ')}</span>
                  </div>
                ))}
              </div>
            ) : null}

            {/* Labels */}
            {pr.labels.length > 0 ? (
              <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
                {pr.labels.map((label) => (
                  <span key={label.name} style={{
                    fontSize: 11,
                    fontWeight: 600,
                    paddingTop: 2,
                    paddingRight: 8,
                    paddingBottom: 2,
                    paddingLeft: 8,
                    borderRadius: 99,
                    color: `#${label.color}`,
                    background: `#${label.color}10`,
                    border: `1px solid #${label.color}25`,
                  }}>
                    {label.name}
                  </span>
                ))}
              </div>
            ) : null}

            {/* Body */}
            {pr.body ? (
              <div style={{ marginTop: 8 }}>
                <MarkdownBody text={pr.body} />
              </div>
            ) : (
              <div style={{ fontSize: 13, color: 'var(--t-text-muted)', fontStyle: 'italic' }}>No description provided</div>
            )}
          </div>
        ) : null}

        {activeSection === 'files' ? (
          <div>
            {pr.files?.length > 0 ? (
              pr.files.map((file, index) => (
                <div key={file.path} data-pr-section="files" data-pr-index={index} style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  paddingTop: 6,
                  paddingRight: 10,
                  paddingBottom: 6,
                  paddingLeft: 8,
                  borderRadius: 10,
                  borderBottom: '1px solid var(--t-divider-subtle)',
                  fontSize: 13,
                  background: activeItemIndex === index ? 'rgba(37,99,235,0.08)' : 'transparent',
                  border: activeItemIndex === index ? '1px solid rgba(37,99,235,0.16)' : '1px solid transparent',
                }}>
                  <FileText size={14} strokeWidth={1.8} style={{ color: 'var(--t-text-muted)', flexShrink: 0 }} />
                  <span style={{ flex: 1, color: 'var(--t-text-strong)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {file.path}
                  </span>
                  <div style={{ display: 'flex', gap: 4, flexShrink: 0, fontSize: 11, fontWeight: 600 }}>
                    {file.additions > 0 ? <span style={{ color: '#22c55e' }}>+{file.additions}</span> : null}
                    {file.deletions > 0 ? <span style={{ color: '#ef4444' }}>-{file.deletions}</span> : null}
                  </div>
                  <span style={{ fontSize: 10, color: 'var(--t-text-faint)', flexShrink: 0 }}>
                    ↵ copies path
                  </span>
                </div>
              ))
            ) : (
              <div style={{ fontSize: 13, color: 'var(--t-text-muted)' }}>No changed files data</div>
            )}
            {pr.diffStat ? (
              <pre style={{
                marginTop: 12,
                fontSize: '0.75rem',
                lineHeight: 1.5,
                fontFamily: '"SF Mono", ui-monospace, monospace',
                color: 'var(--t-text-secondary)',
                whiteSpace: 'pre-wrap',
              }}>
                {pr.diffStat}
              </pre>
            ) : null}
          </div>
        ) : null}

        {activeSection === 'checks' ? (
          <div>
            {ciChecks.length === 0 ? (
              <div style={{ padding: 20, fontSize: 13, color: 'var(--t-text-muted)' }}>No checks configured</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {failedChecks.length > 0 && onInjectChatContext ? (
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <DesktopGlassActionChip
                      icon={<MessageSquare size={12} strokeWidth={2} />}
                      label={addedContextKeys[`checks-all:${pr.number}`] ? 'Added to chat' : 'Add all failed checks'}
                      onClick={() => injectPayload(
                        `checks-all:${pr.number}`,
                        formatCiCheckBatchInjection(
                          pr.number,
                          repo,
                          failedChecks.map((check) => ({
                            prNumber: pr.number,
                            repo,
                            name: check.name,
                            status: check.status,
                            conclusion: check.conclusion,
                            detailsUrl: check.detailsUrl,
                            startedAt: check.startedAt,
                            completedAt: check.completedAt,
                          })),
                        ),
                      )}
                      disabled={Boolean(addedContextKeys[`checks-all:${pr.number}`])}
                    />
                  </div>
                ) : null}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {ciChecks.map((check, i) => {
                  const passed = check.conclusion === 'SUCCESS' || check.conclusion === 'success';
                  const pending = check.status === 'IN_PROGRESS' || check.status === 'QUEUED' || check.status === 'PENDING';
                  const failed = !passed && !pending;
                  const rowBackground = activeItemIndex === i ? 'rgba(37,99,235,0.08)' : 'transparent';
                  // Calculate duration
                  let duration = '';
                  if (check.startedAt && check.completedAt) {
                    const ms = new Date(check.completedAt).getTime() - new Date(check.startedAt).getTime();
                    if (ms < 60_000) duration = `${Math.round(ms / 1000)}s`;
                    else duration = `${Math.round(ms / 60_000)}m`;
                  }
                  return (
                    <div key={i} data-pr-section="checks" data-pr-index={i} style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '8px 12px',
                      borderRadius: 8,
                      transition: 'background 120ms ease',
                      cursor: check.detailsUrl ? 'pointer' : 'default',
                      background: rowBackground,
                      border: activeItemIndex === i ? '1px solid rgba(37,99,235,0.16)' : '1px solid transparent',
                    }}
                    onClick={() => check.detailsUrl && window.open(check.detailsUrl, '_blank')}
                    onMouseEnter={(e) => {
                      if (activeItemIndex !== i) {
                        (e.currentTarget as HTMLDivElement).style.background = 'rgba(0,0,0,0.02)';
                      }
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLDivElement).style.background = rowBackground;
                    }}
                    >
                      {/* Status icon */}
                      <span style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 20, height: 20,
                        borderRadius: '50%',
                        background: passed ? 'rgba(34,197,94,0.08)' : pending ? 'rgba(245,158,11,0.08)' : 'rgba(239,68,68,0.08)',
                        color: passed ? '#22c55e' : pending ? '#f59e0b' : '#ef4444',
                        fontSize: 12, fontWeight: 700,
                        flexShrink: 0,
                        }}>
                          {passed ? '✓' : pending ? '○' : '✗'}
                        </span>
                      {/* Check name */}
                      <span style={{
                        flex: 1,
                        fontSize: 13,
                        fontWeight: 500,
                        color: 'var(--t-text-strong)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}>
                        {check.name}
                      </span>
                      {/* Duration */}
                      {duration ? (
                        <span style={{
                          fontSize: 11,
                          color: 'var(--t-text-muted)',
                          fontFamily: '"SF Mono", ui-monospace, monospace',
                          flexShrink: 0,
                        }}>
                          {duration}
                        </span>
                      ) : null}
                      {/* External link */}
                      {check.detailsUrl ? (
                        <ExternalLink size={12} strokeWidth={1.5} color="var(--t-text-faint)" style={{ flexShrink: 0 }} />
                      ) : null}
                      {!passed && onInjectChatContext ? (
                        <DesktopGlassActionChip
                          icon={addedContextKeys[checkContextKey(check.name)] ? <Check size={12} strokeWidth={2.4} /> : <MessageSquare size={12} strokeWidth={2} />}
                          label={addedContextKeys[checkContextKey(check.name)] ? 'Added' : 'Add to chat'}
                          onClick={() => injectPayload(
                            checkContextKey(check.name),
                            formatCiCheckInjection({
                              prNumber: pr.number,
                              repo,
                              name: check.name,
                              status: check.status,
                              conclusion: check.conclusion,
                              detailsUrl: check.detailsUrl,
                              startedAt: check.startedAt,
                              completedAt: check.completedAt,
                            }),
                          )}
                          disabled={Boolean(addedContextKeys[checkContextKey(check.name)])}
                        />
                      ) : null}
                    </div>
                  );
                })}
                </div>
              </div>
            )}
          </div>
        ) : null}

        {activeSection === 'comments' ? (
          <div>
            {visibleComments.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--t-text-muted)' }}>No comments</div>
            ) : (
              <>
                {onInjectChatContext ? (
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
                    <DesktopGlassActionChip
                      icon={<MessageSquare size={12} strokeWidth={2} />}
                      label={addedContextKeys[`comments-all:${pr.number}`] ? 'Added to chat' : 'Add all to chat'}
                      onClick={() => injectPayload(
                        `comments-all:${pr.number}`,
                        formatReviewCommentBatchInjection(
                          pr.number,
                          repo,
                          visibleComments.map((comment) => ({
                            prNumber: pr.number,
                            repo,
                            author: comment.user,
                            body: comment.body,
                            createdAt: comment.created_at,
                            path: comment.kind === 'review' ? (comment as { path?: string }).path : undefined,
                          })),
                        ),
                      )}
                      disabled={Boolean(addedContextKeys[`comments-all:${pr.number}`])}
                    />
                  </div>
                ) : null}
              {visibleComments.map((comment, index) => {
                const commentKey = `${comment.kind}:${comment.id}`;
                return (
                <div key={`${comment.kind}-${comment.id}`} data-pr-section="comments" data-pr-index={index} style={{
                  marginBottom: 16,
                  paddingBottom: 16,
                  paddingLeft: 10,
                  paddingRight: 10,
                  paddingTop: 10,
                  borderRadius: 12,
                  borderBottom: '1px solid var(--t-divider)',
                  background: activeItemIndex === index ? 'rgba(37,99,235,0.08)' : 'transparent',
                  border: activeItemIndex === index ? '1px solid rgba(37,99,235,0.14)' : '1px solid transparent',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, fontSize: 12, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 600, color: 'var(--t-text-strong)' }}>{comment.user}</span>
                    {comment.kind === 'review' ? (
                      <span style={{
                        fontSize: 10,
                        paddingTop: 1,
                        paddingRight: 5,
                        paddingBottom: 1,
                        paddingLeft: 5,
                        borderRadius: 4,
                        background: 'rgba(139,92,246,0.08)',
                        color: '#8b5cf6',
                        fontFamily: '"SF Mono", ui-monospace, monospace',
                      }}>
                        {'path' in comment ? (comment as { path: string }).path : 'review'}
                      </span>
                    ) : null}
                    <span style={{ color: 'var(--t-text-muted)' }}>{formatAge(comment.created_at)}</span>
                    {onInjectChatContext ? (
                      <>
                        <div style={{ flex: 1 }} />
                        <DesktopGlassActionChip
                          icon={addedContextKeys[commentKey] ? <Check size={12} strokeWidth={2.4} /> : <MessageSquare size={12} strokeWidth={2} />}
                          label={addedContextKeys[commentKey] ? 'Added' : 'Add to chat'}
                          onClick={() => injectPayload(
                            commentKey,
                            formatReviewCommentInjection({
                              prNumber: pr.number,
                              repo,
                              author: comment.user,
                              body: comment.body,
                              createdAt: comment.created_at,
                              path: comment.kind === 'review' ? (comment as { path?: string }).path : undefined,
                            }),
                          )}
                          disabled={Boolean(addedContextKeys[commentKey])}
                        />
                        <DesktopGlassActionChip
                          icon={<X size={12} strokeWidth={2.2} />}
                          label="Hide"
                          variant="muted"
                          onClick={() => hideComment(commentKey)}
                        />
                      </>
                    ) : null}
                  </div>
                  <div style={{ fontSize: 13, lineHeight: 1.6 }}>
                    <MarkdownBody text={comment.body} />
                  </div>
                </div>
                );
              })}
              </>
            )}
          </div>
        ) : null}

        {activeSection === 'reviews' ? (
          <div>
            {reviewsLoading ? (
              <div style={{ fontSize: 13, color: 'var(--t-text-muted)' }}>Loading review comments…</div>
            ) : visibleReviewComments.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--t-text-muted)' }}>No inline review comments</div>
            ) : (
              (() => {
                // Group comments into threads by file path
                const threads = new Map<string, typeof visibleReviewComments>();
                for (const c of visibleReviewComments) {
                  const key = c.path;
                  if (!threads.has(key)) threads.set(key, []);
                  threads.get(key)!.push(c);
                }

                return (
                  <>
                    {onInjectChatContext ? (
                      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
                        <DesktopGlassActionChip
                          icon={<MessageSquare size={12} strokeWidth={2} />}
                          label={addedContextKeys[`review-threads-all:${pr.number}`] ? 'Added to chat' : 'Add all to chat'}
                          onClick={() => injectPayload(
                            `review-threads-all:${pr.number}`,
                            formatReviewCommentBatchInjection(
                              pr.number,
                              repo,
                              visibleReviewComments.map((comment) => ({
                                prNumber: pr.number,
                                repo,
                                author: comment.author,
                                body: comment.body,
                                createdAt: comment.createdAt,
                                path: comment.path,
                                line: comment.line,
                              })),
                            ),
                          )}
                          disabled={Boolean(addedContextKeys[`review-threads-all:${pr.number}`])}
                        />
                      </div>
                    ) : null}
                  {(() => {
                    let reviewIndex = -1;
                    return Array.from(threads.entries()).map(([path, comments]) => (
                  <div key={path} style={{ marginBottom: 20 }}>
                    {/* File path header */}
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      paddingTop: 8,
                      paddingRight: 12,
                      paddingBottom: 8,
                      paddingLeft: 12,
                      borderRadius: 8,
                      background: 'var(--t-hover)',
                      marginBottom: 8,
                    }}>
                      <FileText size={13} strokeWidth={1.8} style={{ color: 'var(--t-text-secondary)', flexShrink: 0 }} />
                      <span style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: 'var(--t-text-strong)',
                        fontFamily: '"SF Mono", ui-monospace, monospace',
                      }}>{path}</span>
                    </div>

                    {/* Comments for this file */}
                    {comments.map((comment) => {
                      reviewIndex += 1;
                      const itemIndex = reviewIndex;
                      const commentKey = `review-thread:${comment.id}`;
                      return (
                      <div key={comment.id} data-pr-section="reviews" data-pr-index={itemIndex} style={{
                        marginBottom: 12,
                        paddingTop: 10,
                        paddingRight: 10,
                        paddingBottom: 10,
                        borderRadius: 12,
                        paddingLeft: 16,
                        borderLeft: '2px solid rgba(139, 92, 246, 0.2)',
                        background: activeItemIndex === itemIndex ? 'rgba(37,99,235,0.08)' : 'transparent',
                        border: activeItemIndex === itemIndex ? '1px solid rgba(37,99,235,0.14)' : '1px solid transparent',
                      }}>
                        {/* Diff context */}
                        {comment.diffHunk ? (
                          <pre style={{
                            margin: 0,
                            marginBottom: 8,
                            paddingTop: 8,
                            paddingRight: 12,
                            paddingBottom: 8,
                            paddingLeft: 12,
                            fontSize: '0.7rem',
                            lineHeight: 1.5,
                            fontFamily: '"SF Mono", ui-monospace, monospace',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                            color: 'var(--t-text-secondary)',
                            background: 'var(--t-hover)',
                            borderRadius: 6,
                            border: '1px solid var(--t-divider-subtle)',
                            maxHeight: 120,
                            overflowY: 'auto',
                          }}>
                            {renderDiffLines(comment.diffHunk)}
                          </pre>
                        ) : null}

                        {/* Line reference */}
                        {comment.line ? (
                          <div style={{
                            fontSize: 10,
                            color: '#8b5cf6',
                            fontFamily: '"SF Mono", ui-monospace, monospace',
                            marginBottom: 4,
                          }}>
                            Line {comment.line}
                          </div>
                        ) : null}

                        {/* Author + timestamp */}
                        <div style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          marginBottom: 4,
                          fontSize: 12,
                          flexWrap: 'wrap',
                        }}>
                          <span style={{ fontWeight: 600, color: 'var(--t-text-strong)' }}>{comment.author}</span>
                          <span style={{ color: 'var(--t-text-muted)' }}>{formatAge(comment.createdAt)}</span>
                          {onInjectChatContext ? (
                            <>
                              <div style={{ flex: 1 }} />
                              <DesktopGlassActionChip
                                icon={addedContextKeys[commentKey] ? <Check size={12} strokeWidth={2.4} /> : <MessageSquare size={12} strokeWidth={2} />}
                                label={addedContextKeys[commentKey] ? 'Added' : 'Add to chat'}
                                onClick={() => injectPayload(
                                  commentKey,
                                  formatReviewCommentInjection({
                                    prNumber: pr.number,
                                    repo,
                                    author: comment.author,
                                    body: comment.body,
                                    createdAt: comment.createdAt,
                                    path: comment.path,
                                    line: comment.line,
                                  }),
                                )}
                                disabled={Boolean(addedContextKeys[commentKey])}
                              />
                              <DesktopGlassActionChip
                                icon={<X size={12} strokeWidth={2.2} />}
                                label="Hide"
                                variant="muted"
                                onClick={() => hideComment(commentKey)}
                              />
                            </>
                          ) : null}
                        </div>

                        {/* Comment body */}
                        <div style={{ fontSize: 13, lineHeight: 1.6 }}>
                          <MarkdownBody text={comment.body} />
                        </div>
                      </div>
                      );
                    })}
                  </div>
                    ));
                  })()}
                  </>
                );
              })()
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ── Commit Viewer ──

interface CommitDetail {
  hash: string;
  shortHash: string;
  subject: string;
  body: string;
  author: string;
  email: string;
  date: string;
  files: { path: string; additions: number | null; deletions: number | null; status?: string }[];
  totalAdditions: number;
  totalDeletions: number;
  diff: string;
}

interface CommitFileCompare {
  path: string;
  status: string;
  commitContent: string | null;
  commitSource: 'commit' | 'parent' | null;
  workspaceContent: string | null;
  workspaceExists: boolean;
  note?: string;
}

function CommitViewer({ commitHash, workspace }: { commitHash: string; workspace?: string }) {
  const { themeId } = useTheme();
  const [commit, setCommit] = useState<CommitDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [compareData, setCompareData] = useState<CommitFileCompare | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [commitComposerOpen, setCommitComposerOpen] = useState(false);
  const [commitMsg, setCommitMsg] = useState('');
  const [commitLoading, setCommitLoading] = useState(false);
  const [pushLoading, setPushLoading] = useState(false);
  const [actionToast, setActionToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const compareBaselineRef = useRef('');
  const diffEditorRef = useRef<import('monaco-editor').editor.IStandaloneDiffEditor | null>(null);
  const diffEditorListenerRef = useRef<import('monaco-editor').IDisposable | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const wsParam = workspace ? `?workspace=${encodeURIComponent(workspace)}` : '';
    fetch(`/api/panel/commits/${commitHash}${wsParam}`)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((data) => {
        if (cancelled) return;
        const nextCommit = (data.commit ?? null) as CommitDetail | null;
        setCommit(nextCommit);
        setSelectedFile((current) => {
          if (current && nextCommit?.files.some((file) => file.path === current)) {
            return current;
          }
          return workspace ? nextCommit?.files[0]?.path ?? null : null;
        });
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Unknown error');
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [commitHash, workspace]);

  useEffect(() => {
    if (!selectedFile) {
      setCompareData(null);
      setEditContent('');
      setDirty(false);
      setSaveNote(null);
      return;
    }

    let cancelled = false;
    setCompareLoading(true);
    setSaveNote(null);
    const wsParam = workspace ? `&workspace=${encodeURIComponent(workspace)}` : '';

    fetch(`/api/panel/commits/${commitHash}/file?path=${encodeURIComponent(selectedFile)}${wsParam}`)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((data) => {
        if (cancelled) return;
        const nextCompare = (data.file ?? null) as CommitFileCompare | null;
        setCompareData(nextCompare);
        const nextContent = nextCompare?.workspaceContent ?? nextCompare?.commitContent ?? '';
        compareBaselineRef.current = nextContent;
        setEditContent(nextContent);
        setDirty(false);
        setCompareLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setCompareData({
          path: selectedFile,
          status: 'unknown',
          commitContent: null,
          commitSource: null,
          workspaceContent: null,
          workspaceExists: false,
          note: err instanceof Error ? err.message : 'Unable to load file compare',
        });
        compareBaselineRef.current = '';
        setEditContent('');
        setDirty(false);
        setCompareLoading(false);
      });

    return () => { cancelled = true; };
  }, [commitHash, selectedFile, workspace]);

  const handleSave = useCallback(async () => {
    if (!workspace || !selectedFile || saving) return false;
    setSaving(true);
    setSaveNote(null);
    try {
      const res = await fetch('/api/v2/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: selectedFile, content: editContent, workspace }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? 'Save failed');
      }
      setCompareData((current) => current
        ? {
            ...current,
            workspaceContent: editContent,
            workspaceExists: true,
          }
        : current);
      compareBaselineRef.current = editContent;
      setDirty(false);
      setSaveNote('Saved');
      setTimeout(() => setSaveNote(null), 2200);
      return true;
    } catch (err) {
      setSaveNote(`Error: ${err instanceof Error ? err.message : 'Save failed'}`);
      return false;
    } finally {
      setSaving(false);
    }
  }, [editContent, saving, selectedFile, workspace]);

  const stageAndCommit = useCallback(async () => {
    if (!workspace || !commitMsg.trim() || commitLoading) return;
    setCommitLoading(true);
    setActionToast(null);
    try {
      if (dirty) {
        const saved = await handleSave();
        if (!saved) {
          setCommitLoading(false);
          return;
        }
      }
      const res = await fetch('/api/review/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: commitMsg, workspace }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Commit failed');
      setActionToast({ type: 'success', message: data.message || `Committed ${data.hash ?? commitHash.slice(0, 7)}` });
      setCommitMsg('');
      setCommitComposerOpen(false);
    } catch (err) {
      setActionToast({ type: 'error', message: err instanceof Error ? err.message : 'Commit failed' });
    } finally {
      setCommitLoading(false);
    }
  }, [commitHash, commitLoading, commitMsg, dirty, handleSave, workspace]);

  const handlePush = useCallback(async () => {
    if (!workspace || pushLoading || saving || commitLoading || dirty) return;
    setPushLoading(true);
    setActionToast(null);
    try {
      const res = await fetch('/api/review/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Push failed');
      setActionToast({
        type: 'success',
        message: data.message || `Pushed ${data.branch ?? 'branch'}${data.upstream ? ` to ${data.upstream}` : ''}`,
      });
    } catch (err) {
      setActionToast({ type: 'error', message: err instanceof Error ? err.message : 'Push failed' });
    } finally {
      setPushLoading(false);
    }
  }, [commitLoading, dirty, pushLoading, saving, workspace]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!selectedFile || !workspace) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleSave, selectedFile, workspace]);

  useEffect(() => () => {
    diffEditorListenerRef.current?.dispose();
  }, []);

  const handleDiffEditorMount = useCallback((editor: unknown) => {
    const diffEditor = editor as import('monaco-editor').editor.IStandaloneDiffEditor;
    diffEditorRef.current = diffEditor;
    diffEditorListenerRef.current?.dispose();
    const modifiedEditor = diffEditor.getModifiedEditor();
    diffEditorListenerRef.current = modifiedEditor.onDidChangeModelContent(() => {
      const value = modifiedEditor.getValue();
      setEditContent(value);
      setDirty(value !== compareBaselineRef.current);
    });
  }, []);

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: 'var(--t-text-muted)' }}>
        Loading commit…
      </div>
    );
  }

  if (error || !commit) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: '#ef4444' }}>
        Failed to load commit: {error || 'Unknown error'}
      </div>
    );
  }

  const fileDiffs = new Map<string, string>();
  if (commit.diff) {
    const sections = commit.diff.split(/^diff --git /m).filter(Boolean);
    for (const section of sections) {
      const firstLine = section.split('\n')[0] ?? '';
      const match = firstLine.match(/b\/(.+)$/);
      if (match) {
        fileDiffs.set(match[1], 'diff --git ' + section);
      }
    }
  }

  const activeDiff = selectedFile ? (fileDiffs.get(selectedFile) ?? '') : commit.diff;
  const selectedFileEntry = selectedFile ? commit.files.find((file) => file.path === selectedFile) ?? null : null;
  const compareLanguage = selectedFile ? getMonacoLanguage(selectedFile) : 'plaintext';
  const editorTheme = themeId === 'dark' ? 'cortex-graphite' : 'cortex-frost';
  const hasWorkspace = Boolean(workspace);
  const normalizedSelectedFilePath = selectedFile
    ? selectedFile.replace(/^\/+/, '').replace(/\s+/g, '-')
    : null;
  const originalModelPath = normalizedSelectedFilePath
    ? `/__cortex_commit__/${commit.hash}/${normalizedSelectedFilePath}`
    : undefined;
  const modifiedModelPath = normalizedSelectedFilePath
    ? `/__cortex_workspace__/${normalizedSelectedFilePath}`
    : undefined;
  const canEditSelectedFile = Boolean(
    workspace
    && selectedFile
    && (
      compareData?.workspaceExists
      || compareData?.commitContent !== null
    ),
  );
  const editorValue = compareData?.workspaceContent ?? compareData?.commitContent ?? editContent;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{
        paddingTop: 11,
        paddingRight: 16,
        paddingBottom: 9,
        paddingLeft: 16,
        borderBottom: '1px solid var(--t-divider)',
        background: 'var(--t-panel-translucent)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <div style={{
            flex: 1,
            minWidth: 0,
            fontSize: 14,
            fontWeight: 600,
            color: 'var(--t-text)',
            lineHeight: 1.35,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {commit.subject}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            {saveNote ? (
              <span style={{
                fontSize: 10,
                fontWeight: 600,
                color: saveNote.startsWith('Error') ? '#ef4444' : '#16a34a',
              }}>
                {saveNote}
              </span>
            ) : null}
            {hasWorkspace ? (
              <>
                <button
                  type="button"
                  onClick={() => void handleSave()}
                  disabled={!selectedFile || !hasWorkspace || saving || !dirty}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    height: 26,
                    padding: '0 10px',
                    borderRadius: 999,
                    border: '1px solid var(--t-divider)',
                    background: dirty ? 'var(--t-panel-translucent)' : 'transparent',
                    color: dirty ? 'var(--t-text)' : 'var(--t-text-muted)',
                    fontSize: 10,
                    fontWeight: 700,
                    cursor: dirty ? 'pointer' : 'default',
                  }}
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <button
                  type="button"
                  onClick={() => setCommitComposerOpen((current) => !current)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    height: 26,
                    padding: '0 10px',
                    borderRadius: 999,
                    border: '1px solid var(--t-divider)',
                    background: commitComposerOpen || commitMsg.trim() ? 'var(--t-panel-translucent)' : 'transparent',
                    color: commitComposerOpen || commitMsg.trim() ? 'var(--t-text)' : 'var(--t-text-muted)',
                    fontSize: 10,
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  <Check size={12} />
                  Commit
                </button>
                <button
                  type="button"
                  onClick={() => void handlePush()}
                  disabled={!hasWorkspace || pushLoading || saving || commitLoading || dirty}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    height: 26,
                    padding: '0 10px',
                    borderRadius: 999,
                    border: '1px solid var(--t-divider)',
                    background: pushLoading ? 'var(--t-panel-translucent)' : 'transparent',
                    color: pushLoading || (!dirty && !saving && !commitLoading) ? 'var(--t-text-secondary)' : 'var(--t-text-muted)',
                    fontSize: 10,
                    fontWeight: 700,
                    cursor: !dirty && !saving && !commitLoading ? 'pointer' : 'default',
                  }}
                >
                  <Send size={11} />
                  {pushLoading ? 'Pushing…' : 'Push'}
                </button>
              </>
            ) : (
              <span style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>
                Read-only
              </span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, fontSize: 11, color: 'var(--t-text-muted)', flexWrap: 'wrap' }}>
          <span style={{
            fontFamily: '"SF Mono", ui-monospace, monospace',
            fontSize: 10,
            paddingTop: 1,
            paddingRight: 6,
            paddingBottom: 1,
            paddingLeft: 6,
            borderRadius: 999,
            background: 'var(--t-divider-subtle)',
            color: 'var(--t-text-muted)',
          }}>
            {commit.shortHash}
          </span>
          <span>{commit.author}</span>
          <span>·</span>
          <span>{formatAge(commit.date)}</span>
          <span>·</span>
          <span style={{ color: 'rgba(34,197,94,0.9)', fontWeight: 600 }}>+{commit.totalAdditions}</span>
          <span style={{ color: 'rgba(37,99,235,0.9)', fontWeight: 600 }}>-{commit.totalDeletions}</span>
          <span>{commit.files.length} file{commit.files.length !== 1 ? 's' : ''}</span>
        </div>
        {commit.body ? (
          <div style={{ marginTop: 5, fontSize: 12, color: 'var(--t-text-muted)', lineHeight: 1.4, whiteSpace: 'pre-wrap' }}>
            {commit.body}
          </div>
        ) : null}
      </div>

      {hasWorkspace && commitComposerOpen ? (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          paddingTop: 8,
          paddingRight: 16,
          paddingBottom: 8,
          paddingLeft: 20,
          borderBottom: '1px solid var(--t-divider-subtle)',
          background: 'var(--t-panel-translucent)',
          flexShrink: 0,
        }}>
          <input
            type="text"
            placeholder="Commit message..."
            value={commitMsg}
            onChange={(event) => setCommitMsg(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && commitMsg.trim()) {
                event.preventDefault();
                void stageAndCommit();
              }
              if (event.key === 'Escape') {
                setCommitComposerOpen(false);
              }
            }}
            style={{
              flex: 1,
              minWidth: 0,
              border: '1px solid var(--t-divider)',
              borderRadius: 10,
              padding: '8px 11px',
              fontSize: 12,
              background: 'var(--t-panel)',
              color: 'var(--t-text)',
              outline: 'none',
            }}
          />
          <button
            type="button"
            onClick={() => void stageAndCommit()}
            disabled={!commitMsg.trim() || commitLoading}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 32,
              padding: '0 12px',
              borderRadius: 10,
              border: '1px solid rgba(34,197,94,0.22)',
              background: commitMsg.trim() ? 'rgba(34,197,94,0.12)' : 'transparent',
              color: commitMsg.trim() ? '#16a34a' : 'var(--t-text-muted)',
              fontSize: 12,
              fontWeight: 700,
              cursor: commitMsg.trim() ? 'pointer' : 'default',
            }}
          >
            <Check size={13} />
            {commitLoading ? 'Committing…' : 'Stage All + Commit'}
          </button>
          <button
            type="button"
            onClick={() => setCommitComposerOpen(false)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 32,
              height: 32,
              borderRadius: 10,
              border: '1px solid var(--t-divider)',
              background: 'transparent',
              color: 'var(--t-text-muted)',
              cursor: 'pointer',
            }}
          >
            <X size={13} />
          </button>
        </div>
      ) : null}

      {actionToast ? (
        <div style={{
          paddingTop: 4,
          paddingRight: 20,
          paddingBottom: 4,
          paddingLeft: 20,
          fontSize: 11,
          fontWeight: 600,
          color: actionToast.type === 'success' ? '#16a34a' : '#ef4444',
          background: actionToast.type === 'success'
            ? 'rgba(34,197,94,0.06)'
            : 'rgba(239,68,68,0.08)',
          flexShrink: 0,
        }}>
          {actionToast.message}
        </div>
      ) : null}

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <div style={{
          width: 260,
          flexShrink: 0,
          borderRight: '1px solid var(--t-divider)',
          overflowY: 'auto',
          background: 'var(--t-bg-subtle)',
        }}>
          <button
            type="button"
            onClick={() => setSelectedFile(null)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              width: '100%',
              paddingTop: 10,
              paddingRight: 12,
              paddingBottom: 10,
              paddingLeft: 14,
              border: 'none',
              borderLeft: selectedFile === null ? '2px solid #2563eb' : '2px solid transparent',
              background: selectedFile === null ? 'rgba(37, 99, 235, 0.06)' : 'transparent',
              cursor: 'pointer',
              textAlign: 'left',
              fontFamily: '-apple-system, system-ui, sans-serif',
              fontSize: 13,
              fontWeight: selectedFile === null ? 600 : 400,
              color: 'var(--t-text-strong)',
            }}
          >
            Overview ({commit.files.length})
          </button>

          {commit.files.map((file) => {
            const isActive = selectedFile === file.path;
            const fileName = file.path.split('/').pop() ?? file.path;
            const dirPath = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';

            return (
              <button
                key={file.path}
                type="button"
                onClick={() => setSelectedFile(file.path)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  paddingTop: 8,
                  paddingRight: 12,
                  paddingBottom: 8,
                  paddingLeft: 14,
                  border: 'none',
                  borderLeft: isActive ? '2px solid #2563eb' : '2px solid transparent',
                  background: isActive ? 'rgba(37, 99, 235, 0.06)' : 'transparent',
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontFamily: '-apple-system, system-ui, sans-serif',
                  transition: 'all 100ms ease',
                }}
              >
                <DiffStatusIcon status={file.status ?? 'modified'} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 13,
                    fontWeight: isActive ? 600 : 400,
                    color: 'var(--t-text-strong)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>{fileName}</div>
                  {dirPath ? (
                    <div style={{
                      fontSize: 11,
                      color: 'var(--t-text-muted)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>{dirPath}</div>
                  ) : null}
                </div>
                <div style={{ display: 'flex', gap: 4, flexShrink: 0, fontSize: 11, fontWeight: 600 }}>
                  {(file.additions ?? 0) > 0 ? <span style={{ color: '#22c55e' }}>+{file.additions}</span> : null}
                  {(file.deletions ?? 0) > 0 ? <span style={{ color: '#2563eb' }}>-{file.deletions}</span> : null}
                </div>
                <ChevronRight size={12} strokeWidth={2} style={{ color: 'var(--t-text-faint)', flexShrink: 0 }} />
              </button>
            );
          })}
        </div>

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {selectedFile ? (
            <>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                paddingTop: 10,
                paddingRight: 16,
                paddingBottom: 10,
                paddingLeft: 16,
                borderBottom: '1px solid var(--t-divider-subtle)',
                background: 'var(--t-panel-translucent)',
                flexShrink: 0,
              }}>
                <FileText size={14} strokeWidth={1.8} style={{ color: 'var(--t-text-muted)' }} />
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t-text)' }}>
                  {selectedFileEntry?.path ?? selectedFile}
                </span>
                {selectedFileEntry ? (
                  <span style={{ fontSize: 11, color: '#16a34a', fontWeight: 700 }}>
                    +{selectedFileEntry.additions ?? 0}
                  </span>
                ) : null}
                {selectedFileEntry ? (
                  <span style={{ fontSize: 11, color: '#2563eb', fontWeight: 700 }}>
                    -{selectedFileEntry.deletions ?? 0}
                  </span>
                ) : null}
                <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--t-text-muted)' }}>
                  {compareData?.note ?? ''}
                </span>
              </div>

              <div style={{ flex: 1, minHeight: 0 }}>
                {compareLoading ? (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: 'var(--t-text-muted)' }}>
                    Loading live compare…
                  </div>
                ) : compareData && compareData.commitContent !== null && compareData.workspaceContent !== null ? (
                  <MonacoDiffEditor
                    height="100%"
                    language={compareLanguage}
                    original={compareData.commitContent}
                    modified={editContent}
                    originalModelPath={originalModelPath}
                    modifiedModelPath={modifiedModelPath}
                    keepCurrentOriginalModel
                    keepCurrentModifiedModel
                    theme={editorTheme}
                    beforeMount={defineCortexMonacoThemes}
                    onMount={handleDiffEditorMount}
                    options={{
                      readOnly: !canEditSelectedFile,
                      originalEditable: false,
                      renderSideBySide: true,
                      minimap: { enabled: false },
                      scrollBeyondLastLine: false,
                      wordWrap: 'on',
                      lineNumbers: 'on',
                      padding: { top: 12, bottom: 12 },
                      overviewRulerBorder: false,
                      glyphMargin: false,
                      scrollbar: {
                        verticalScrollbarSize: 8,
                        horizontalScrollbarSize: 8,
                        useShadows: false,
                      },
                    }}
                  />
                ) : (
                  <MonacoEditor
                    height="100%"
                    language={compareLanguage}
                    value={editorValue}
                    theme={editorTheme}
                    beforeMount={defineCortexMonacoThemes}
                    onChange={(value) => {
                      if (!canEditSelectedFile || value === undefined) return;
                      setEditContent(value);
                      setDirty(value !== (compareData?.workspaceContent ?? compareData?.commitContent ?? ''));
                    }}
                    options={{
                      readOnly: !canEditSelectedFile,
                      fontSize: 13,
                      fontFamily: '"SF Mono", "Menlo", "Monaco", "Cascadia Code", ui-monospace, monospace',
                      lineHeight: 20,
                      tabSize: 2,
                      insertSpaces: true,
                      minimap: { enabled: false },
                      scrollBeyondLastLine: false,
                      wordWrap: 'on',
                      lineNumbers: 'on',
                      padding: { top: 12, bottom: 12 },
                      glyphMargin: false,
                      overviewRulerLanes: 0,
                      overviewRulerBorder: false,
                      scrollbar: {
                        verticalScrollbarSize: 8,
                        horizontalScrollbarSize: 8,
                        useShadows: false,
                      },
                    }}
                  />
                )}
              </div>
            </>
          ) : (
            <div style={{ flex: 1, overflowY: 'auto' }}>
              <pre style={{
                margin: 0,
                paddingTop: 14,
                paddingRight: 16,
                paddingBottom: 14,
                paddingLeft: 16,
                fontSize: '0.8rem',
                lineHeight: 1.65,
                fontFamily: '"SF Mono", "Menlo", "Monaco", ui-monospace, monospace',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                color: 'var(--t-text-strong)',
              }}>
                {renderDiffLines(activeDiff)}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Diff Viewer (inline version of DiffModal) ──

interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
  additions: number | null;
  deletions: number | null;
}

interface FileDetail {
  path: string;
  status: string;
  additions: number | null;
  deletions: number | null;
  preview: string;
  note?: string;
  commitSummary?: string;
  commitAuthor?: string;
  commitAge?: string;
}

const diffStatusColors: Record<string, string> = {
  added: '#22c55e',
  modified: '#f59e0b',
  deleted: '#ef4444',
  renamed: '#8b5cf6',
  untracked: '#6b7280',
};

function DiffStatusIcon({ status }: { status: string }) {
  const color = diffStatusColors[status] ?? '#6b7280';
  const size = 15;
  switch (status) {
    case 'added': return <FilePlus size={size} strokeWidth={1.8} style={{ color, flexShrink: 0 }} />;
    case 'deleted': return <FileMinus size={size} strokeWidth={1.8} style={{ color, flexShrink: 0 }} />;
    case 'modified': return <FileEdit size={size} strokeWidth={1.8} style={{ color, flexShrink: 0 }} />;
    default: return <FileText size={size} strokeWidth={1.8} style={{ color, flexShrink: 0 }} />;
  }
}

function DiffHunk({ hunkHeader, lines, startIndex, defaultExpanded }: {
  hunkHeader: string;
  lines: string[];
  startIndex: number;
  defaultExpanded: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  // Parse line numbers from @@ -old,len +new,len @@
  const hunkMatch = hunkHeader.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  let oldLine = hunkMatch ? parseInt(hunkMatch[1], 10) : 1;
  let newLine = hunkMatch ? parseInt(hunkMatch[2], 10) : 1;

  return (
    <div>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          paddingTop: 4,
          paddingRight: 12,
          paddingBottom: 4,
          paddingLeft: 8,
          background: 'rgba(99, 102, 241, 0.06)',
          color: '#6366f1',
          fontSize: '0.75rem',
          fontFamily: '"SF Mono", ui-monospace, monospace',
          cursor: 'pointer',
          userSelect: 'none',
          borderTop: '1px solid var(--t-divider-subtle)',
          borderBottom: '1px solid var(--t-divider-subtle)',
        }}
      >
        <ChevronRight
          size={11}
          style={{
            transition: 'transform 150ms ease',
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            flexShrink: 0,
          }}
        />
        <span style={{ flex: 1 }}>{hunkHeader}</span>
        <span style={{ color: 'var(--t-text-muted)', fontSize: 10 }}>{lines.length} lines</span>
      </div>
      {expanded && lines.map((line, i) => {
        let color = 'var(--t-text)';
        let bg = 'transparent';
        let leftNum: string = '';
        let rightNum: string = '';

        if (line.startsWith('+') && !line.startsWith('+++')) {
          color = '#166534';
          bg = 'rgba(34, 197, 94, 0.08)';
          rightNum = String(newLine++);
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          color = '#991b1b';
          bg = 'rgba(239, 68, 68, 0.08)';
          leftNum = String(oldLine++);
        } else {
          leftNum = String(oldLine++);
          rightNum = String(newLine++);
        }

        return (
          <div key={startIndex + i} style={{ display: 'flex', color, background: bg }}>
            <span style={{
              width: 42,
              flexShrink: 0,
              textAlign: 'right',
              paddingRight: 6,
              color: 'var(--t-text-faint)',
              fontSize: '0.7rem',
              fontFamily: '"SF Mono", ui-monospace, monospace',
              userSelect: 'none',
              borderRight: '1px solid var(--t-divider-subtle)',
            }}>{leftNum}</span>
            <span style={{
              width: 42,
              flexShrink: 0,
              textAlign: 'right',
              paddingRight: 6,
              color: 'var(--t-text-faint)',
              fontSize: '0.7rem',
              fontFamily: '"SF Mono", ui-monospace, monospace',
              userSelect: 'none',
              borderRight: '1px solid var(--t-divider-subtle)',
            }}>{rightNum}</span>
            <span style={{
              flex: 1,
              paddingLeft: 8,
              paddingTop: 1,
              paddingBottom: 1,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}>{line || '\u00A0'}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Lightweight syntax highlighting ──

function getFileLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
    md: 'markdown', mdx: 'markdown',
    env: 'env', sh: 'shell', bash: 'shell', zsh: 'shell',
    css: 'css', scss: 'css', html: 'html', xml: 'html',
    py: 'python', rs: 'rust', go: 'go', rb: 'ruby',
    sql: 'sql', graphql: 'graphql', gql: 'graphql',
    dockerfile: 'docker', gitignore: 'config',
  };
  const name = path.split('/').pop()?.toLowerCase() ?? '';
  if (name.startsWith('.env')) return 'env';
  if (name === 'dockerfile') return 'docker';
  if (name === '.gitignore' || name === '.dockerignore') return 'config';
  return map[ext] || 'text';
}

const syntaxColors = {
  keyword: '#c678dd',    // purple
  string: '#98c379',     // green
  number: '#d19a66',     // orange
  comment: '#5c6370',    // gray
  property: '#e06c75',   // red
  type: '#e5c07b',       // yellow
  punctuation: '#abb2bf', // light gray
  env_key: '#e06c75',    // red
  env_value: '#98c379',  // green
  env_equals: '#56b6c2', // cyan
};

function highlightLine(line: string, lang: string): React.ReactNode {
  // ENV files: KEY=VALUE
  if (lang === 'env') {
    if (line.startsWith('#')) return <span style={{ color: syntaxColors.comment }}>{line}</span>;
    const eqIdx = line.indexOf('=');
    if (eqIdx > 0) {
      return (
        <>
          <span style={{ color: syntaxColors.env_key }}>{line.slice(0, eqIdx)}</span>
          <span style={{ color: syntaxColors.env_equals }}>=</span>
          <span style={{ color: syntaxColors.env_value }}>{line.slice(eqIdx + 1)}</span>
        </>
      );
    }
    return line;
  }

  // JSON: basic key/value coloring
  if (lang === 'json') {
    return line.replace(/^(\s*)("(?:[^"\\]|\\.)*")(\s*:\s*)?/g, (_match, indent, key, colon) => {
      // This is a simplified approach — return the raw line with spans
      void indent; void key; void colon;
      return _match;
    }) ? <span dangerouslySetInnerHTML={{ __html:
      line
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/("(?:[^"\\]|\\.)*")(\s*:)/g, `<span style="color:${syntaxColors.property}">$1</span>$2`)
        .replace(/:(\s*"(?:[^"\\]|\\.)*")/g, `:<span style="color:${syntaxColors.string}">$1</span>`)
        .replace(/:(\s*(?:\d+\.?\d*|true|false|null))/g, `:<span style="color:${syntaxColors.number}">$1</span>`)
    }} /> : <>{line}</>;
  }

  // TypeScript/JavaScript: basic keyword highlighting
  if (lang === 'typescript' || lang === 'javascript') {
    if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*') || line.trimStart().startsWith('/*')) {
      return <span style={{ color: syntaxColors.comment }}>{line}</span>;
    }
    return <span dangerouslySetInnerHTML={{ __html:
      line
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/\b(import|export|from|const|let|var|function|return|if|else|for|while|class|interface|type|extends|implements|async|await|new|throw|try|catch|finally|typeof|instanceof|in|of|default|switch|case|break|continue|void|null|undefined|true|false)\b/g,
          `<span style="color:${syntaxColors.keyword}">$1</span>`)
        .replace(/('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)/g,
          `<span style="color:${syntaxColors.string}">$1</span>`)
        .replace(/\b(\d+\.?\d*)\b/g, `<span style="color:${syntaxColors.number}">$1</span>`)
    }} />;
  }

  // YAML: key: value
  if (lang === 'yaml') {
    if (line.trimStart().startsWith('#')) return <span style={{ color: syntaxColors.comment }}>{line}</span>;
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0 && !line.trimStart().startsWith('-')) {
      return (
        <>
          <span style={{ color: syntaxColors.property }}>{line.slice(0, colonIdx)}</span>
          <span style={{ color: syntaxColors.punctuation }}>:</span>
          <span style={{ color: syntaxColors.string }}>{line.slice(colonIdx + 1)}</span>
        </>
      );
    }
    return line;
  }

  // Shell: comments and basic
  if (lang === 'shell') {
    if (line.trimStart().startsWith('#')) return <span style={{ color: syntaxColors.comment }}>{line}</span>;
    return line;
  }

  // Config files (.gitignore etc)
  if (lang === 'config') {
    if (line.trimStart().startsWith('#')) return <span style={{ color: syntaxColors.comment }}>{line}</span>;
    return line;
  }

  // Markdown: headers
  if (lang === 'markdown') {
    if (line.startsWith('#')) return <span style={{ color: syntaxColors.keyword, fontWeight: 600 }}>{line}</span>;
    return line;
  }

  return line;
}

function renderDiffLines(text: string) {
  // Split into hunks for collapsible rendering
  const allLines = text.split('\n');
  const hunks: { header: string; lines: string[]; startIndex: number }[] = [];
  const preamble: string[] = [];
  let currentHunk: { header: string; lines: string[]; startIndex: number } | null = null;

  allLines.forEach((line, i) => {
    if (line.startsWith('@@')) {
      if (currentHunk) hunks.push(currentHunk);
      currentHunk = { header: line, lines: [], startIndex: i + 1 };
    } else if (currentHunk) {
      currentHunk.lines.push(line);
    } else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
      preamble.push(line);
    } else {
      preamble.push(line);
    }
  });
  if (currentHunk) hunks.push(currentHunk);

  // If no hunks found, fall back to simple rendering
  if (hunks.length === 0) {
    return allLines.map((line, i) => {
      let color = 'var(--t-text)';
      let bg = 'transparent';
      if (line.startsWith('+') && !line.startsWith('+++')) { color = '#166534'; bg = 'rgba(34, 197, 94, 0.08)'; }
      else if (line.startsWith('-') && !line.startsWith('---')) { color = '#991b1b'; bg = 'rgba(239, 68, 68, 0.08)'; }
      else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) { color = 'var(--t-text-secondary)'; }
      return <div key={i} style={{ color, background: bg, paddingTop: 1, paddingBottom: 1, paddingLeft: 8 }}>{line || '\u00A0'}</div>;
    });
  }

  return (
    <>
      {preamble.map((line, i) => (
        <div key={`pre-${i}`} style={{ color: 'var(--t-text-secondary)', paddingTop: 1, paddingBottom: 1, paddingLeft: 8 }}>{line || '\u00A0'}</div>
      ))}
      {hunks.map((hunk, i) => (
        <DiffHunk
          key={`hunk-${i}`}
          hunkHeader={hunk.header}
          lines={hunk.lines}
          startIndex={hunk.startIndex}
          defaultExpanded={hunks.length <= 5}
        />
      ))}
    </>
  );
}

// ── Mermaid Viewer (Canvas tab — zoom/pan diagram) ──

function MermaidViewer({ code }: { code: string }) {
  const [svgHtml, setSvgHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(2);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const dragging = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });

  useEffect(() => {
    let cancelled = false;
    async function render() {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: 'base' as const,
          themeVariables: {
            primaryColor: 'var(--t-panel)',
            primaryTextColor: 'var(--t-text)',
            primaryBorderColor: 'var(--t-panel-border)',
            secondaryColor: '#f0f7ff',
            secondaryTextColor: 'var(--t-text)',
            secondaryBorderColor: 'var(--t-text-faint)',
            tertiaryColor: '#fef2f2',
            tertiaryTextColor: '#991b1b',
            tertiaryBorderColor: '#ef4444',
            lineColor: 'var(--t-text-muted)',
            textColor: 'var(--t-text)',
            mainBkg: 'var(--t-panel)',
            nodeBorder: 'var(--t-panel-border)',
            clusterBkg: 'var(--t-bg-subtle)',
            clusterBorder: 'var(--t-panel-border)',
            titleColor: 'var(--t-text-strong)',
            edgeLabelBackground: 'var(--t-panel)',
            nodeTextColor: 'var(--t-text)',
            cScale0: '#ef4444',
            fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
            fontSize: '14px',
          },
          securityLevel: 'loose',
        });
        const id = `mermaid-canvas-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const { svg } = await mermaid.render(id, code);
        if (!cancelled) setSvgHtml(svg);
      } catch (err) {
        if (!cancelled) setError(String(err));
      }
    }
    void render();
    return () => { cancelled = true; };
  }, [code]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.15 : 0.15;
    setScale(s => Math.min(Math.max(s + delta, 0.25), 10));
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    dragging.current = true;
    lastPos.current = { x: e.clientX, y: e.clientY };
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging.current) return;
    const dx = e.clientX - lastPos.current.x;
    const dy = e.clientY - lastPos.current.y;
    lastPos.current = { x: e.clientX, y: e.clientY };
    setTranslate(t => ({ x: t.x + dx, y: t.y + dy }));
  }, []);

  const handleMouseUp = useCallback(() => { dragging.current = false; }, []);

  if (error) {
    return (
      <div style={{ padding: 20, fontSize: 13, color: '#ef4444', fontFamily: 'ui-monospace, monospace' }}>
        Mermaid render error: {error}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingTop: 10,
        paddingRight: 14,
        paddingBottom: 10,
        paddingLeft: 16,
        borderBottom: '1px solid var(--t-divider)',
        flexShrink: 0,
      }}>
        <span style={{
          fontSize: 13,
          fontWeight: 700,
          color: '#2563eb',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          fontFamily: '-apple-system, system-ui, sans-serif',
        }}>
          Mermaid Diagram
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            type="button"
            onClick={() => setScale(s => Math.max(s - 0.5, 0.25))}
            title="Zoom out"
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 28, height: 28, borderRadius: 8,
              border: '1px solid var(--t-divider)', background: 'var(--t-panel-translucent)',
              color: 'var(--t-text-secondary)', cursor: 'pointer',
              paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
            }}
          >
            <span style={{ fontSize: 16, lineHeight: 1 }}>-</span>
          </button>
          <span style={{
            fontSize: 12, fontWeight: 600, color: 'var(--t-text-secondary)',
            minWidth: 40, textAlign: 'center',
            fontFamily: '"SF Mono", ui-monospace, monospace',
          }}>
            {Math.round(scale * 100)}%
          </span>
          <button
            type="button"
            onClick={() => setScale(s => Math.min(s + 0.5, 10))}
            title="Zoom in"
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 28, height: 28, borderRadius: 8,
              border: '1px solid var(--t-divider)', background: 'var(--t-panel-translucent)',
              color: 'var(--t-text-secondary)', cursor: 'pointer',
              paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
            }}
          >
            <span style={{ fontSize: 16, lineHeight: 1 }}>+</span>
          </button>
          <button
            type="button"
            onClick={() => { setScale(2); setTranslate({ x: 0, y: 0 }); }}
            title="Reset zoom"
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              height: 28, borderRadius: 8, paddingLeft: 8, paddingRight: 8,
              paddingTop: 0, paddingBottom: 0,
              border: '1px solid var(--t-divider)', background: 'var(--t-panel-translucent)',
              color: 'var(--t-text-secondary)', cursor: 'pointer',
              fontSize: 11, fontWeight: 600,
            }}
          >
            Fit
          </button>
        </div>
      </div>
      {/* Diagram area */}
      <div
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        style={{
          flex: 1,
          overflow: 'hidden',
          cursor: dragging.current ? 'grabbing' : 'grab',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundImage: 'linear-gradient(135deg, rgba(255,255,255,0.8) 0%, rgba(240,247,255,0.4) 100%)',
        }}
      >
        {svgHtml ? (
          <div
            dangerouslySetInnerHTML={{ __html: svgHtml }}
            style={{
              transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
              transformOrigin: 'center center',
              transition: dragging.current ? 'none' : 'transform 100ms ease',
            }}
          />
        ) : (
          <span style={{ fontSize: 13, color: 'var(--t-text-muted)' }}>Rendering diagram...</span>
        )}
      </div>
    </div>
  );
}

function DiffViewer() {
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileDetail, setFileDetail] = useState<FileDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [commitMsg, setCommitMsg] = useState('');
  const [commitLoading, setCommitLoading] = useState(false);
  const [actionToast, setActionToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);

  const refreshFiles = useCallback(async () => {
    try {
      const res = await fetch('/api/review/workspace');
      if (!res.ok) return;
      const data = await res.json();
      setFiles(data.changedFiles ?? []);
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    void refreshFiles().then(() => setLoading(false));
  }, [refreshFiles]);

  const selectFile = useCallback(async (path: string) => {
    setSelectedFile(path);
    setDetailLoading(true);
    setFileDetail(null);
    try {
      const res = await fetch(`/api/review/file?path=${encodeURIComponent(path)}`);
      if (!res.ok) return;
      const data = await res.json();
      setFileDetail(data.file ?? null);
    } catch { /* silent */ }
    finally { setDetailLoading(false); }
  }, []);

  const copyPath = useCallback((path: string) => {
    void navigator.clipboard.writeText(path);
    setCopiedPath(path);
    setTimeout(() => setCopiedPath(null), 1500);
  }, []);

  const discardFile = useCallback(async (path: string) => {
    try {
      const res = await fetch('/api/review/discard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      setActionToast({ type: 'success', message: `Discarded ${path.split('/').pop()}` });
      if (selectedFile === path) { setSelectedFile(null); setFileDetail(null); }
      await refreshFiles();
    } catch (err) {
      setActionToast({ type: 'error', message: err instanceof Error ? err.message : 'Failed' });
    }
  }, [selectedFile, refreshFiles]);

  const stageAndCommit = useCallback(async () => {
    if (!commitMsg.trim()) return;
    setCommitLoading(true);
    setActionToast(null);
    try {
      const res = await fetch('/api/review/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: commitMsg }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Commit failed');
      setActionToast({ type: 'success', message: data.message || 'Committed' });
      setCommitMsg('');
      setSelectedFile(null);
      setFileDetail(null);
      await refreshFiles();
    } catch (err) {
      setActionToast({ type: 'error', message: err instanceof Error ? err.message : 'Commit failed' });
    } finally {
      setCommitLoading(false);
    }
  }, [commitMsg, refreshFiles]);

  const totalAdditions = files.reduce((sum, f) => sum + (f.additions ?? 0), 0);
  const totalDeletions = files.reduce((sum, f) => sum + (f.deletions ?? 0), 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        paddingTop: 12,
        paddingRight: 16,
        paddingBottom: 12,
        paddingLeft: 20,
        borderBottom: '1px solid var(--t-divider)',
        background: 'var(--t-panel-translucent)',
        flexShrink: 0,
      }}>
        <span style={{
          fontSize: 13,
          fontWeight: 700,
          color: 'var(--t-text)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
        }}>
          Workspace Diff
        </span>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#22c55e' }}>+{totalAdditions}</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#ef4444' }}>-{totalDeletions}</span>
        <span style={{ fontSize: 12, color: 'var(--t-text-secondary)' }}>
          {files.length} file{files.length !== 1 ? 's' : ''}
        </span>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => { setLoading(true); void refreshFiles().then(() => setLoading(false)); }}
          title="Refresh"
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 28, height: 28, borderRadius: 6,
            border: '1px solid var(--t-divider)', background: 'transparent',
            color: 'var(--t-text-secondary)', cursor: 'pointer', padding: 0,
          }}
        >
          <RotateCcw size={13} />
        </button>
      </div>

      {/* Stage + Commit bar */}
      {files.length > 0 && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          paddingTop: 6,
          paddingRight: 16,
          paddingBottom: 6,
          paddingLeft: 20,
          borderBottom: '1px solid var(--t-divider)',
          background: 'var(--t-hover)',
          flexShrink: 0,
        }}>
          <input
            type="text"
            placeholder="Commit message..."
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && commitMsg.trim()) { e.preventDefault(); void stageAndCommit(); } }}
            style={{
              flex: 1,
              border: '1px solid var(--t-divider)',
              borderRadius: 8,
              paddingTop: 6, paddingRight: 10, paddingBottom: 6, paddingLeft: 10,
              fontSize: 12,
              background: 'var(--t-panel)',
              color: 'var(--t-text)',
              outline: 'none',
              fontFamily: '-apple-system, system-ui, sans-serif',
            }}
          />
          <button
            type="button"
            onClick={() => void stageAndCommit()}
            disabled={!commitMsg.trim() || commitLoading}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              paddingTop: 6, paddingRight: 12, paddingBottom: 6, paddingLeft: 10,
              borderRadius: 8, border: 'none',
              background: commitMsg.trim() ? '#22c55e' : 'var(--t-divider)',
              color: commitMsg.trim() ? '#fff' : 'var(--t-text-muted)',
              fontSize: 11, fontWeight: 600,
              cursor: commitMsg.trim() ? 'pointer' : 'default',
              fontFamily: '-apple-system, system-ui, sans-serif',
            }}
          >
            <Check size={12} />
            {commitLoading ? 'Committing...' : 'Stage All + Commit'}
          </button>
        </div>
      )}

      {/* Action toast */}
      {actionToast && (
        <div style={{
          paddingTop: 4, paddingRight: 20, paddingBottom: 4, paddingLeft: 20,
          fontSize: 11, fontWeight: 500, flexShrink: 0,
          color: actionToast.type === 'success' ? '#22c55e' : '#ef4444',
          background: actionToast.type === 'success' ? 'rgba(34,197,94,0.06)' : 'rgba(239,68,68,0.06)',
        }}>
          {actionToast.message}
        </div>
      )}

      {/* Body: file list + diff preview */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* File list sidebar */}
        <div style={{
          width: 260,
          flexShrink: 0,
          borderRight: '1px solid var(--t-divider)',
          overflowY: 'auto',
          background: 'var(--t-bg-subtle)',
        }}>
          {loading ? (
            <div style={{ padding: 20, fontSize: 13, color: 'var(--t-text-muted)' }}>Loading…</div>
          ) : files.length === 0 ? (
            <div style={{ padding: 20, fontSize: 13, color: 'var(--t-text-muted)' }}>Working tree clean</div>
          ) : (
            files.map((file) => {
              const isActive = selectedFile === file.path;
              const fileName = file.path.split('/').pop() ?? file.path;
              const dirPath = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';

              return (
                <div
                  key={file.path}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    borderLeft: isActive ? '2px solid #2563eb' : '2px solid transparent',
                    background: isActive ? 'rgba(37, 99, 235, 0.06)' : 'transparent',
                    transition: 'all 100ms ease',
                  }}
                >
                  <button
                    type="button"
                    onClick={() => void selectFile(file.path)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      flex: 1,
                      minWidth: 0,
                      paddingTop: 10,
                      paddingRight: 4,
                      paddingBottom: 10,
                      paddingLeft: 12,
                      border: 'none',
                      background: 'transparent',
                      cursor: 'pointer',
                      textAlign: 'left',
                      fontFamily: '-apple-system, system-ui, sans-serif',
                    }}
                  >
                    <DiffStatusIcon status={file.status} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontSize: 13,
                        fontWeight: isActive ? 600 : 400,
                        color: 'var(--t-text-strong)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}>{fileName}</div>
                      {dirPath ? (
                        <div style={{
                          fontSize: 11,
                          color: 'var(--t-text-muted)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}>{dirPath}</div>
                      ) : null}
                    </div>
                    <div style={{ display: 'flex', gap: 4, flexShrink: 0, fontSize: 11, fontWeight: 600 }}>
                      {(file.additions ?? 0) > 0 ? (
                        <span style={{ color: '#22c55e' }}>+{file.additions}</span>
                      ) : null}
                      {(file.deletions ?? 0) > 0 ? (
                        <span style={{ color: '#ef4444' }}>-{file.deletions}</span>
                      ) : null}
                    </div>
                  </button>
                  {/* Quick actions */}
                  <div style={{ display: 'flex', gap: 2, paddingRight: 6, flexShrink: 0 }}>
                    <button
                      type="button"
                      title="Copy path"
                      onClick={(e) => { e.stopPropagation(); copyPath(file.path); }}
                      style={{
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        width: 22, height: 22, borderRadius: 4,
                        border: 'none', background: 'transparent',
                        color: copiedPath === file.path ? '#22c55e' : 'var(--t-text-faint)',
                        cursor: 'pointer', padding: 0,
                      }}
                    >
                      {copiedPath === file.path ? <Check size={11} /> : <Clipboard size={11} />}
                    </button>
                    <button
                      type="button"
                      title="Discard changes"
                      onClick={(e) => { e.stopPropagation(); void discardFile(file.path); }}
                      style={{
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        width: 22, height: 22, borderRadius: 4,
                        border: 'none', background: 'transparent',
                        color: 'var(--t-text-faint)',
                        cursor: 'pointer', padding: 0,
                      }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ef4444'; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--t-text-faint)'; }}
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Diff preview */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {!selectedFile ? (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              fontSize: 14,
              color: 'var(--t-text-muted)',
            }}>
              Select a file to see the diff
            </div>
          ) : detailLoading ? (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              fontSize: 13,
              color: 'var(--t-text-muted)',
            }}>
              Loading diff…
            </div>
          ) : fileDetail ? (
            <div>
              <div style={{
                paddingTop: 12,
                paddingRight: 16,
                paddingBottom: 12,
                paddingLeft: 16,
                borderBottom: '1px solid var(--t-divider)',
                background: 'var(--t-panel-translucent)',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
              }}>
                <DiffStatusIcon status={fileDetail.status} />
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text-strong)' }}>{fileDetail.path}</span>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: '#22c55e' }}>+{fileDetail.additions ?? 0}</span>
                  <span style={{ fontSize: 11, fontWeight: 600, color: '#ef4444' }}>-{fileDetail.deletions ?? 0}</span>
                  <button
                    type="button"
                    title="Copy path"
                    onClick={() => copyPath(fileDetail.path)}
                    style={{
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      width: 26, height: 26, borderRadius: 6, marginLeft: 4,
                      border: '1px solid var(--t-divider)', background: 'transparent',
                      color: copiedPath === fileDetail.path ? '#22c55e' : 'var(--t-text-secondary)',
                      cursor: 'pointer', padding: 0,
                    }}
                  >
                    {copiedPath === fileDetail.path ? <Check size={12} /> : <Clipboard size={12} />}
                  </button>
                  <button
                    type="button"
                    title="Discard changes"
                    onClick={() => void discardFile(fileDetail.path)}
                    style={{
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      width: 26, height: 26, borderRadius: 6,
                      border: '1px solid rgba(239,68,68,0.2)', background: 'transparent',
                      color: '#ef4444',
                      cursor: 'pointer', padding: 0,
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
              {fileDetail.commitSummary ? (
                <div style={{
                  paddingTop: 8,
                  paddingRight: 16,
                  paddingBottom: 8,
                  paddingLeft: 16,
                  borderBottom: '1px solid var(--t-divider-subtle)',
                  fontSize: 12,
                  color: 'var(--t-text-secondary)',
                }}>
                  {fileDetail.commitSummary} — {fileDetail.commitAuthor} ({fileDetail.commitAge})
                </div>
              ) : null}
              <pre style={{
                margin: 0,
                paddingTop: 4,
                paddingRight: 0,
                paddingBottom: 14,
                paddingLeft: 0,
                fontSize: '0.8rem',
                lineHeight: 1.65,
                fontFamily: '"SF Mono", "Menlo", "Monaco", ui-monospace, monospace',
                color: 'var(--t-text-strong)',
              }}>
                {renderDiffLines(fileDetail.preview)}
              </pre>
            </div>
          ) : (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              fontSize: 13,
              color: '#ef4444',
            }}>
              Could not load file diff
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Utilities ──

function formatAge(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const hours = Math.floor(diffMs / 3_600_000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}
