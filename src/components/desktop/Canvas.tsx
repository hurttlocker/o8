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
import {
  AnimatePresence,
  motion,
} from 'framer-motion';
import {
  AlertCircle,
  BookOpen,
  Check,
  Clock,
  Clipboard,
  ExternalLink,
  FileText,
  GitCommit,
  GitPullRequest,
  Globe,
  Hexagon,
  Plus,
  Radio,
  RefreshCw,
  RotateCcw,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import { AuditLogPanel } from '@/components/desktop/AuditLogPanel';
import { MarkdownBody } from './MarkdownBody';
import { IssueCreator } from './IssueCreator';
import { IssueViewer } from './IssueViewer';
import { FileViewer } from './FileViewer';
import { PRViewer } from './PRViewer';
import { CommitViewer } from './CommitViewer';
import { DiffStatusIcon, renderDiffLines } from './diff-utils';
import { repoSlugFromRemote, readinessTone, formatAge, LIGHT_CANVAS_VARS, type CanvasRepoTaskLaunchRequest } from './canvas-utils';
export { type CanvasRepoTaskLaunchRequest } from './canvas-utils';
// GraphExplorer3D lazy-loaded — only needed for 'memory' tab kind
import { lazy, Suspense } from 'react';
const LazyGraphExplorer3D = lazy(() => import('./GraphExplorer3D').then(m => ({ default: m.GraphExplorer3D })));
import {
  formatCiCheckBatchInjection,
  formatCiCheckInjection,
  type AgentPanelChatInjectionPayload,
} from '@/lib/chat/injection';
import { useTheme } from '@/lib/theme/context';
import type { AgentSummary } from '@/lib/fleet/types';
import type { MobileInboxSnapshot } from '@/lib/mobile/types';
import type { RepoReadiness, RepoRegistryEntry } from '@/lib/repos/types';
import { measureHeight } from '@/lib/pretext';

// ── Tab Types ──

export type CanvasTabKind = 'issue' | 'transcript' | 'file' | 'diff' | 'commit' | 'pr' | 'readme' | 'ci' | 'new-issue' | 'git-log' | 'image' | 'deploy' | 'memory' | 'welcome' | 'timeline' | 'audit-log' | 'mermaid' | 'preview';

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


type CanvasEmptyMode = 'idle' | 'welcome';

function canvasEmptyRepoLabel(selectedRepo?: string | null) {
  if (!selectedRepo) return null;
  return selectedRepo.split('/').pop() ?? selectedRepo;
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

  return (
    <div style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      background: 'var(--t-bg-subtle)',
      borderTop: '1px solid var(--t-divider)',
    }}>
      {tabs.length > 0 ? (
        <>
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
        </>
      ) : null}

      {/* Tab content */}
      <div style={{
        flex: 1,
        overflow: 'hidden',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
      }}>
        <AnimatePresence mode="wait" initial={false}>
          {activeTab ? (
            <motion.div
              key={activeTab.id}
              style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
              initial={{ opacity: 0, y: 10, scale: 0.992, filter: 'blur(4px)' }}
              animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: 10, scale: 0.992, filter: 'blur(4px)' }}
              transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            >
              <TabContent
                tab={activeTab}
                selectedRepo={selectedRepo}
                onSelectCommit={onSelectCommit}
                onInjectChatContext={onInjectChatContext}
                onLaunchWorkspaceTask={onLaunchWorkspaceTask}
              />
            </motion.div>
          ) : (
            <motion.div
              key="canvas-empty"
              style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
              initial={{ opacity: 0, y: 10, scale: 0.992, filter: 'blur(4px)' }}
              animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: 10, scale: 0.992, filter: 'blur(4px)' }}
              transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            >
              <CanvasEmpty selectedRepo={selectedRepo} mode="idle" />
            </motion.div>
          )}
        </AnimatePresence>
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
    case 'audit-log': return <Clipboard size={size} />;
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
      return <CanvasEmpty selectedRepo={selectedRepo} mode="welcome" />;
    case 'timeline':
      return <TimelineExpanded />;
    case 'audit-log':
      return <AuditLogPanel />;
    case 'mermaid':
      return <MermaidViewer code={tab.resourceId} />;
    case 'preview':
      return <PortPreview url={tab.resourceId} port={parseInt(tab.meta?.port ?? '0', 10)} repo={tab.meta?.repo} />;
    default:
      return <CanvasEmpty selectedRepo={selectedRepo} mode="idle" />;
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


// ── Transcript Viewer (Pretext-powered virtual scroll) ──

interface TranscriptMessage {
  role: string;
  content: string | object;
}

/** Redact secrets from transcript text before display */
function redactSecrets(raw: string): string {
  return raw
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, 'Bearer [redacted]')
    .replace(/\b(?:api[_-]?key|access[_-]?token|secret|password|token)\b(\s*[:=]\s*)([^\s"'`]+)/gi, '$1[redacted]')
    .replace(/\b(?:ghp_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{12,})\b/g, '[redacted]');
}

/** Extract display text from a transcript message (capped + redacted) */
function getMessageText(msg: TranscriptMessage): string {
  const raw = typeof msg.content === 'string'
    ? msg.content.slice(0, 2000)
    : JSON.stringify(msg.content).slice(0, 2000);
  return redactSecrets(raw);
}

// Padding/spacing constants for transcript cards
const TX_PADDING_V = 12; // paddingTop + paddingBottom
const TX_PADDING_H = 0;  // no horizontal padding — full-width like chat
const TX_ROLE_HEIGHT = 18; // role label line
const TX_GAP = 4;          // gap between role label and content
const TX_MARGIN_BOTTOM = 8;
const TX_CONTAINER_PAD_H = 16; // container horizontal padding

const TranscriptViewer = memo(function TranscriptViewer({ sessionKey }: { sessionKey: string }) {
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [containerWidth, setContainerWidth] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    fetch(`/api/mobile/history?sessionKey=${encodeURIComponent(sessionKey)}&limit=500`)
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

  // Observe container size for layout calculations
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const rect = entry.contentRect;
        setViewportHeight(rect.height);
        setContainerWidth(rect.width);
      }
    });
    ro.observe(el);
    // Initial measurement
    setViewportHeight(el.clientHeight);
    setContainerWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Pretext: calculate all message heights via pure math (no DOM reflow).
  // contentWidth = container width minus padding on both sides minus card padding.
  const contentWidth = containerWidth - TX_CONTAINER_PAD_H * 2 - TX_PADDING_H * 2;
  const messageHeights = useMemo(() => {
    if (contentWidth <= 0) return [];
    return messages.map((msg) => {
      const text = getMessageText(msg);
      // measureHeight from Pretext — pure math, ~0.09ms per call
      const textH = measureHeight(text, 'small', contentWidth, 1.55, 'pre-wrap');
      return TX_PADDING_V * 2 + TX_ROLE_HEIGHT + TX_GAP + textH + TX_MARGIN_BOTTOM;
    });
  }, [messages, contentWidth]);

  // Cumulative offsets for fast binary search
  const offsets = useMemo(() => {
    const arr = new Float64Array(messageHeights.length + 1);
    for (let i = 0; i < messageHeights.length; i++) {
      arr[i + 1] = arr[i] + messageHeights[i];
    }
    return arr;
  }, [messageHeights]);

  const totalHeight = offsets.length > 0 ? offsets[offsets.length - 1] : 0;

  // Binary search for first visible message index
  const findStartIndex = useCallback((top: number): number => {
    let lo = 0, hi = offsets.length - 2;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (offsets[mid + 1] <= top) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }, [offsets]);

  // Virtual window: only render visible messages + buffer
  const BUFFER = 5;
  const startIdx = Math.max(0, findStartIndex(scrollTop) - BUFFER);
  const endIdx = useMemo(() => {
    const bottomEdge = scrollTop + viewportHeight;
    let idx = startIdx;
    while (idx < messages.length && offsets[idx] < bottomEdge + 200) idx++;
    return Math.min(idx + BUFFER, messages.length);
  }, [startIdx, scrollTop, viewportHeight, messages.length, offsets]);

  const offsetY = offsets[startIdx] || 0;
  const visibleMessages = messages.slice(startIdx, endIdx);

  // Auto-scroll to bottom on initial load
  useEffect(() => {
    if (!loading && containerRef.current && messages.length > 0) {
      containerRef.current.scrollTop = totalHeight;
    }
  }, [loading, messages.length, totalHeight]);

  // Scroll handler — RAF batched
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let rafId = 0;
    const onScroll = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        setScrollTop(el.scrollTop);
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(rafId);
    };
  }, []);

  if (loading) {
    return (
      <div style={{ padding: 32, color: 'var(--t-text-muted)', fontSize: 13 }}>
        Loading transcript...
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{
        overflowY: 'auto',
        height: '100%',
        background: '#ffffff',
        ...LIGHT_CANVAS_VARS,
      } as React.CSSProperties}
    >
      {messages.length === 0 ? (
        <div style={{ color: 'var(--t-text-muted)', fontSize: 13, padding: 16, margin: '16px 24px' }}>
          No messages in this session.
        </div>
      ) : (
        <div style={{
          height: totalHeight,
          position: 'relative',
          paddingLeft: TX_CONTAINER_PAD_H,
          paddingRight: TX_CONTAINER_PAD_H,
          paddingTop: 16,
        }}>
          <div style={{ position: 'absolute', top: 16 + offsetY, left: TX_CONTAINER_PAD_H, right: TX_CONTAINER_PAD_H }}>
            {visibleMessages.map((msg, i) => {
              const globalIdx = startIdx + i;
              const isUser = msg.role === 'user';
              return (
                <div
                  key={globalIdx}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: isUser ? 'flex-end' : 'flex-start',
                    marginBottom: TX_MARGIN_BOTTOM,
                    paddingTop: TX_PADDING_V,
                    paddingBottom: TX_PADDING_V,
                    paddingLeft: 16,
                    paddingRight: 16,
                    fontSize: 14,
                    lineHeight: 1.6,
                    fontFamily: '-apple-system, system-ui, sans-serif',
                    // Pretext: explicit height — browser never calculates this
                    height: messageHeights[globalIdx] - TX_MARGIN_BOTTOM,
                    boxSizing: 'border-box',
                  }}
                >
                  <div style={{
                    maxWidth: isUser ? '75%' : '90%',
                    color: isUser ? '#6b7280' : '#111827',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}>
                    {getMessageText(msg)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
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

function CanvasEmpty({ selectedRepo, mode = 'idle' }: { selectedRepo?: string | null; mode?: CanvasEmptyMode }) {
  const repoLabel = canvasEmptyRepoLabel(selectedRepo);
  const title = mode === 'welcome'
    ? 'Canvas ready'
    : 'Content will appear here';
  const subtitle = repoLabel
    ? `Click an issue, file, or transcript from ${repoLabel} and the inspector will open here.`
    : 'Click an issue, file, or transcript and the inspector will open here.';

  return (
    <div style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      minHeight: 280,
      padding: 24,
      position: 'relative',
      overflow: 'hidden',
      background: 'linear-gradient(180deg, var(--t-bg-subtle) 0%, var(--t-bg) 100%)',
    }}>
      <div style={{
        position: 'absolute',
        inset: -60,
        pointerEvents: 'none',
        background: 'radial-gradient(circle at 16% 18%, var(--t-accent-soft, rgba(37, 99, 235, 0.08)) 0%, transparent 34%), radial-gradient(circle at 82% 22%, rgba(148, 163, 184, 0.16) 0%, transparent 30%), radial-gradient(circle at 50% 92%, rgba(37, 99, 235, 0.06) 0%, transparent 34%)',
        opacity: 0.9,
      }} />

      <motion.div
        layout
        style={{
          position: 'relative',
          maxWidth: 840,
          width: '100%',
          margin: '0 auto',
          borderRadius: 14,
          border: '1px solid var(--t-divider)',
          background: 'var(--t-panel-translucent)',
          backdropFilter: 'blur(22px) saturate(1.5)',
          WebkitBackdropFilter: 'blur(22px) saturate(1.5)',
          boxShadow: 'var(--t-panel-shadow)',
          overflow: 'hidden',
        }}
        initial={{ opacity: 0, y: 10, scale: 0.994 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.994 }}
        transition={{ type: 'spring', stiffness: 400, damping: 30 }}
      >
        <div style={{
          padding: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 18,
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 16,
            flexWrap: 'wrap',
          }}>
            <div style={{ minWidth: 0 }}>
              <div style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '4px 10px',
                borderRadius: 10,
                border: '1px solid var(--t-divider-subtle)',
                background: 'var(--t-divider-subtle)',
                color: 'var(--t-text-muted)',
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
              }}>
                <span style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: THEME_ACCENT,
                  opacity: 0.8,
                  flexShrink: 0,
                }} />
                Canvas
              </div>
              <div style={{
                marginTop: 12,
                fontSize: 22,
                lineHeight: 1.12,
                fontWeight: 650,
                letterSpacing: '-0.02em',
                color: 'var(--t-text)',
                fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
              }}>
                {title}
              </div>
              <div style={{
                marginTop: 8,
                maxWidth: 620,
                fontSize: 13,
                lineHeight: 1.55,
                color: 'var(--t-text-muted)',
                letterSpacing: '-0.01em',
                fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
              }}>
                {subtitle}
              </div>
            </div>

            {repoLabel ? (
              <div style={{
                display: 'inline-flex',
                alignItems: 'center',
                minHeight: 28,
                padding: '0 10px',
                borderRadius: 10,
                border: '1px solid var(--t-divider-subtle)',
                background: 'rgba(255, 255, 255, 0.46)',
                color: 'var(--t-text-secondary)',
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: '-0.01em',
                fontFamily: '"SF Mono", ui-monospace, monospace',
                flexShrink: 0,
              }}>
                {repoLabel}
              </div>
            ) : null}
          </div>

          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: 12,
          }}>
            {[
              {
                label: 'Issue',
                accent: THEME_ACCENT,
                badge: 'Issue #128',
                lines: [72, 88, 63],
                footer: 'Status · review pending',
              },
              {
                label: 'File',
                accent: 'var(--t-text-secondary)',
                badge: 'src/app/dashboard/page.tsx',
                lines: [92, 84, 68, 76, 54],
                footer: 'File preview · ready',
              },
              {
                label: 'Transcript',
                accent: 'var(--t-text-secondary)',
                badge: 'Session replay',
                lines: [86, 74, 92, 60],
                footer: 'Transcript · live context',
              },
            ].map((card, index) => (
              <motion.div
                key={card.label}
                style={{
                  borderRadius: 14,
                  border: '1px solid var(--t-divider-subtle)',
                  background: 'linear-gradient(180deg, rgba(255,255,255,0.7) 0%, rgba(255,255,255,0.38) 100%)',
                  padding: 14,
                  minHeight: 160,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12,
                  opacity: 0.92,
                }}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ type: 'spring', stiffness: 400, damping: 30, delay: index * 0.05 }}
              >
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                }}>
                  <div style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    minHeight: 24,
                    padding: '0 10px',
                    borderRadius: 10,
                    border: '1px solid var(--t-divider-subtle)',
                    background: THEME_ACCENT_SOFT,
                    color: card.accent,
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
                  }}>
                    {card.label}
                  </div>
                  <div style={{
                    width: 18,
                    height: 18,
                    borderRadius: 999,
                    border: '1px solid var(--t-divider-subtle)',
                    background: 'rgba(255,255,255,0.55)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'var(--t-text-faint)',
                  }}>
                    <svg width={8} height={8} viewBox="0 0 8 8" fill="currentColor" style={{ display: 'block' }}>
                      <circle cx="4" cy="4" r="4" />
                    </svg>
                  </div>
                </div>

                <div style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  flex: 1,
                  minHeight: 0,
                }}>
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    color: 'var(--t-text-secondary)',
                    fontSize: 12,
                    fontWeight: 600,
                    letterSpacing: '-0.01em',
                    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
                  }}>
                    <div style={{
                      width: 10,
                      height: 10,
                      borderRadius: 3,
                      background: 'var(--t-divider-subtle)',
                      border: '1px solid var(--t-divider)',
                    }} />
                    {card.badge}
                  </div>

                  <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                    padding: 12,
                    borderRadius: 12,
                    border: '1px solid var(--t-divider-subtle)',
                    background: 'rgba(255,255,255,0.5)',
                  }}>
                    {card.lines.map((width, lineIndex) => (
                      <div
                        key={`${card.label}-${lineIndex}`}
                        style={{
                          height: lineIndex === 0 ? 12 : 10,
                          width: `${width}%`,
                          borderRadius: 999,
                          background: lineIndex === 0
                            ? 'linear-gradient(90deg, var(--t-divider-subtle) 0%, rgba(37, 99, 235, 0.14) 100%)'
                            : 'var(--t-divider-subtle)',
                          opacity: lineIndex === 0 ? 0.88 : 0.7,
                        }}
                      />
                    ))}
                  </div>
                </div>

                <div style={{
                  marginTop: 'auto',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  fontSize: 11,
                  lineHeight: 1.4,
                  color: 'var(--t-text-faint)',
                  letterSpacing: '-0.01em',
                  fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
                }}>
                  <span>{card.footer}</span>
                  <span style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    padding: '2px 8px',
                    borderRadius: 10,
                    border: '1px solid var(--t-divider-subtle)',
                    background: 'rgba(255,255,255,0.5)',
                  }}>
                    preview
                  </span>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </motion.div>
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
  // [pretext] Track diff preview pane width for zero-reflow line height measurement.
  const [diffPaneWidth, setDiffPaneWidth] = useState(0);
  const diffPaneRef = useRef<HTMLDivElement | null>(null);
  const diffPaneObserverRef = useRef<ResizeObserver | null>(null);

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

  // [pretext] ResizeObserver on the diff preview pane — tracks width for zero-reflow measurement.
  const diffPaneRefCallback = useCallback((node: HTMLDivElement | null) => {
    if (diffPaneObserverRef.current) {
      diffPaneObserverRef.current.disconnect();
      diffPaneObserverRef.current = null;
    }
    diffPaneRef.current = node;
    if (node) {
      setDiffPaneWidth(node.clientWidth);
      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const w = entry.contentBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
          setDiffPaneWidth(w);
        }
      });
      observer.observe(node);
      diffPaneObserverRef.current = observer;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (diffPaneObserverRef.current) {
        diffPaneObserverRef.current.disconnect();
      }
    };
  }, []);

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

        {/* Diff preview — ref tracked for Pretext width measurement */}
        <div ref={diffPaneRefCallback} style={{ flex: 1, overflowY: 'auto' }}>
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
              {/* [pretext] font-size 12px / lineHeight 1.5 matches FONTS['mono'] in pretext engine */}
              <pre style={{
                margin: 0,
                paddingTop: 4,
                paddingRight: 0,
                paddingBottom: 14,
                paddingLeft: 0,
                fontSize: 12,
                lineHeight: 1.5,
                fontFamily: '"SF Mono", "Menlo", "Monaco", ui-monospace, monospace',
                color: 'var(--t-text-strong)',
              }}>
                {renderDiffLines(fileDetail.preview, diffPaneWidth)}
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

